import { expect, test } from './helpers/test.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const HARNESS_URL = '/tests/browser/fixtures/webgl-harness.html';
const CURRENT_DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=smoke-density-transaction`;

test('GPU smoke density bounds uploads and draw submissions for large point sets', async ({
  page,
}) => {
  await page.goto(HARNESS_URL);
  const proof = await page.evaluate(async () => {
    const {
      buildDensityTextureGPU,
      disposeDensityPipelineResources,
      MAX_SPLAT_POINTS_PER_BATCH,
    } = await import('/assets/js/rendering/smoke-cloud/smoke-density.js');
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const gl = canvas.getContext('webgl2');
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Bounded smoke test requires WebGL2');
    }

    const prototype = WebGL2RenderingContext.prototype;
    const originalBufferData = prototype.bufferData;
    const originalBufferSubData = prototype.bufferSubData;
    const originalDrawArraysInstanced = prototype.drawArraysInstanced;
    const originalReadPixels = prototype.readPixels;
    const numericBufferAllocations = [];
    const uploadedElementCounts = [];
    const uploadedSourceOffsets = [];
    const drawInstanceCounts = [];
    let readPixelsCalls = 0;
    prototype.bufferData = function (...args) {
      if (this === gl && typeof args[1] === 'number') {
        numericBufferAllocations.push(args[1]);
      }
      return Reflect.apply(originalBufferData, this, args);
    };
    prototype.bufferSubData = function (...args) {
      if (this === gl) {
        const source = args[2];
        const sourceOffset = args[3] ?? 0;
        const elementCount = args[4] ?? (source.length - sourceOffset);
        uploadedSourceOffsets.push(sourceOffset);
        uploadedElementCounts.push(elementCount);
      }
      return Reflect.apply(originalBufferSubData, this, args);
    };
    prototype.drawArraysInstanced = function (...args) {
      if (this === gl) drawInstanceCounts.push(args[3]);
      return Reflect.apply(originalDrawArraysInstanced, this, args);
    };
    prototype.readPixels = function (...args) {
      if (this === gl) readPixelsCalls++;
      return Reflect.apply(originalReadPixels, this, args);
    };

    const pointCount = MAX_SPLAT_POINTS_PER_BATCH + 1;
    const positions = new Float32Array(pointCount * 3);
    positions[(pointCount - 1) * 3] = 0.75;
    let candidate = null;
    let disposedFirst = false;
    let disposedSecond = false;
    const startedAt = performance.now();
    try {
      candidate = buildDensityTextureGPU(gl, positions, {
        gamma: 0.7,
        gridSize: 8,
      });
      gl.deleteTexture(candidate.texture);
      candidate = null;
      disposedFirst = disposeDensityPipelineResources(gl);
      disposedSecond = disposeDensityPipelineResources(gl);
    } finally {
      if (candidate?.texture) gl.deleteTexture(candidate.texture);
      prototype.bufferData = originalBufferData;
      prototype.bufferSubData = originalBufferSubData;
      prototype.drawArraysInstanced = originalDrawArraysInstanced;
      prototype.readPixels = originalReadPixels;
    }
    return {
      disposedFirst,
      disposedSecond,
      drawInstanceCounts,
      elapsedMs: performance.now() - startedAt,
      maxBatch: MAX_SPLAT_POINTS_PER_BATCH,
      numericBufferAllocations,
      pointCount,
      readPixelsCalls,
      uploadedElementCounts,
      uploadedSourceOffsets,
      webglError: gl.getError(),
    };
  });

  expect(proof.numericBufferAllocations).toEqual([
    proof.maxBatch * 3 * Float32Array.BYTES_PER_ELEMENT,
  ]);
  expect(proof.uploadedElementCounts).toEqual([
    proof.maxBatch * 3,
    3,
  ]);
  expect(proof.uploadedSourceOffsets).toEqual([
    0,
    proof.maxBatch * 3,
  ]);
  expect(proof.drawInstanceCounts).toEqual([proof.maxBatch, 1]);
  expect(
    proof.drawInstanceCounts.reduce((sum, count) => sum + count, 0),
  ).toBe(proof.pointCount);
  expect(proof).toMatchObject({
    disposedFirst: true,
    disposedSecond: false,
    readPixelsCalls: 0,
    webglError: 0,
  });
  expect(proof.elapsedMs).toBeGreaterThan(0);
});

test('GPU smoke density streams filtered positions through one bounded staging batch', async ({
  page,
}) => {
  await page.goto(HARNESS_URL);
  const proof = await page.evaluate(async () => {
    const {
      buildDensityTextureGPU,
      disposeDensityPipelineResources,
      MAX_SPLAT_POINTS_PER_BATCH,
    } = await import('/assets/js/rendering/smoke-cloud/smoke-density.js');
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const gl = canvas.getContext('webgl2');
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Filtered smoke streaming test requires WebGL2');
    }

    const prototype = WebGL2RenderingContext.prototype;
    const originalBufferData = prototype.bufferData;
    const originalBufferSubData = prototype.bufferSubData;
    const originalDrawArraysInstanced = prototype.drawArraysInstanced;
    const numericBufferAllocations = [];
    const uploads = [];
    const drawInstanceCounts = [];
    prototype.bufferData = function (...args) {
      if (this === gl && typeof args[1] === 'number') {
        numericBufferAllocations.push(args[1]);
      }
      return Reflect.apply(originalBufferData, this, args);
    };
    prototype.bufferSubData = function (...args) {
      if (this === gl) {
        const source = args[2];
        const sourceOffset = args[3] ?? 0;
        const elementCount = args[4] ?? (source.length - sourceOffset);
        uploads.push({
          elementCount,
          first: Array.from(source.subarray(sourceOffset, sourceOffset + 3)),
          sourceLength: source.length,
          sourceOffset,
          tail: Array.from(source.subarray(
            sourceOffset + elementCount - 3,
            sourceOffset + elementCount,
          )),
        });
      }
      return Reflect.apply(originalBufferSubData, this, args);
    };
    prototype.drawArraysInstanced = function (...args) {
      if (this === gl) drawInstanceCounts.push(args[3]);
      return Reflect.apply(originalDrawArraysInstanced, this, args);
    };

    const pointCount = MAX_SPLAT_POINTS_PER_BATCH + 2;
    const positions = new Float32Array(pointCount * 3);
    const alpha = new Float32Array(pointCount);
    alpha.fill(1);
    alpha[1] = 0;
    positions[3] = -0.875;
    const lastPositionOffset = (pointCount - 1) * 3;
    positions[lastPositionOffset] = 0.75;
    positions[lastPositionOffset + 1] = -0.5;
    positions[lastPositionOffset + 2] = 0.25;
    let candidate = null;
    try {
      candidate = buildDensityTextureGPU(gl, positions, {
        gamma: 0.7,
        gridSize: 8,
        visibility: {
          alpha,
          outlierQuantiles: null,
          outlierThreshold: null,
        },
      });
      gl.deleteTexture(candidate.texture);
      candidate = null;
      disposeDensityPipelineResources(gl);
    } finally {
      if (candidate?.texture) gl.deleteTexture(candidate.texture);
      prototype.bufferData = originalBufferData;
      prototype.bufferSubData = originalBufferSubData;
      prototype.drawArraysInstanced = originalDrawArraysInstanced;
    }
    return {
      drawInstanceCounts,
      maxBatch: MAX_SPLAT_POINTS_PER_BATCH,
      numericBufferAllocations,
      uploads,
      webglError: gl.getError(),
    };
  });

  expect(proof.numericBufferAllocations).toEqual([
    proof.maxBatch * 3 * Float32Array.BYTES_PER_ELEMENT,
  ]);
  expect(proof.drawInstanceCounts).toEqual([proof.maxBatch, 1]);
  expect(proof.uploads).toEqual([
    {
      elementCount: proof.maxBatch * 3,
      first: [0, 0, 0],
      sourceLength: proof.maxBatch * 3,
      sourceOffset: 0,
      tail: [0, 0, 0],
    },
    {
      elementCount: 3,
      first: [0.75, -0.5, 0.25],
      sourceLength: proof.maxBatch * 3,
      sourceOffset: 0,
      tail: [0.75, -0.5, 0.25],
    },
  ]);
  expect(proof.webglError).toBe(0);
});

test('GPU smoke density discards a failed pipeline cache before the next build', async ({
  page,
}) => {
  await page.goto(HARNESS_URL);
  const proof = await page.evaluate(async () => {
    const {
      buildDensityTextureGPU,
      disposeDensityPipelineResources,
    } = await import('/assets/js/rendering/smoke-cloud/smoke-density.js');
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const gl = canvas.getContext('webgl2');
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Smoke cache recovery test requires WebGL2');
    }

    const prototype = WebGL2RenderingContext.prototype;
    const originalBufferData = prototype.bufferData;
    let rejectNextPipelineBuffer = true;
    prototype.bufferData = function (...args) {
      if (
        this === gl
        && rejectNextPipelineBuffer
        && args[1] instanceof Float32Array
        && args[1].length === 8
      ) {
        rejectNextPipelineBuffer = false;
        return Reflect.apply(
          originalBufferData,
          this,
          [args[0], -1, args[2]],
        );
      }
      return Reflect.apply(originalBufferData, this, args);
    };

    let firstFailure = null;
    let secondCandidate = null;
    try {
      try {
        buildDensityTextureGPU(
          gl,
          new Float32Array([0, 0, 0]),
          { gamma: 0.7, gridSize: 8 },
        );
      } catch (error) {
        firstFailure = error instanceof Error ? error.message : String(error);
      }
      secondCandidate = buildDensityTextureGPU(
        gl,
        new Float32Array([0, 0, 0]),
        { gamma: 0.7, gridSize: 8 },
      );
      gl.deleteTexture(secondCandidate.texture);
      secondCandidate = null;
      return {
        cacheDisposed: disposeDensityPipelineResources(gl),
        firstFailure,
        secondBuildSucceeded: true,
        webglError: gl.getError(),
      };
    } finally {
      if (secondCandidate?.texture) gl.deleteTexture(secondCandidate.texture);
      prototype.bufferData = originalBufferData;
    }
  });

  expect(proof).toMatchObject({
    cacheDisposed: true,
    secondBuildSucceeded: true,
    webglError: 0,
  });
  expect(proof.firstFailure).toMatch(/corner buffer upload.*0x501/i);
});

test('failed GPU smoke builds restore exact GL state and release every resource', async ({
  page,
}) => {
  await page.goto(HARNESS_URL);
  const proof = await page.evaluate(async () => {
    const {
      buildDensityTextureGPU,
      disposeDensityPipelineResources,
    } = await import('/assets/js/rendering/smoke-cloud/smoke-density.js');
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const gl = canvas.getContext('webgl2');
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Smoke failure transaction requires WebGL2');
    }

    const compileShader = (type, source) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('State fixture shader allocation failed');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) || 'State fixture shader failed');
      }
      return shader;
    };
    const vertexShader = compileShader(
      gl.VERTEX_SHADER,
      '#version 300 es\nvoid main(){gl_Position=vec4(0.0);}',
    );
    const fragmentShader = compileShader(
      gl.FRAGMENT_SHADER,
      '#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(1.0);}',
    );
    const priorProgram = gl.createProgram();
    if (!priorProgram) throw new Error('State fixture program allocation failed');
    gl.attachShader(priorProgram, vertexShader);
    gl.attachShader(priorProgram, fragmentShader);
    gl.linkProgram(priorProgram);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(priorProgram, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(priorProgram) || 'State fixture link failed');
    }

    const priorDrawFramebuffer = gl.createFramebuffer();
    const priorReadFramebuffer = gl.createFramebuffer();
    const priorBuffer = gl.createBuffer();
    const priorVertexArray = gl.createVertexArray();
    if (
      !priorDrawFramebuffer
      || !priorReadFramebuffer
      || !priorBuffer
      || !priorVertexArray
    ) {
      throw new Error('State fixture allocation failed');
    }
    const textureUnits = [gl.TEXTURE0, gl.TEXTURE1, gl.TEXTURE0 + 5];
    const priorTextures = [];
    const priorSamplers = [];
    for (const unit of textureUnits) {
      const texture2D = gl.createTexture();
      const texture3D = gl.createTexture();
      const sampler = gl.createSampler();
      if (!texture2D || !texture3D || !sampler) {
        throw new Error('State fixture texture allocation failed');
      }
      priorTextures.push(texture2D, texture3D);
      priorSamplers.push(sampler);
      gl.activeTexture(unit);
      gl.bindTexture(gl.TEXTURE_2D, texture2D);
      gl.bindTexture(gl.TEXTURE_3D, texture3D);
      gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.bindSampler(unit - gl.TEXTURE0, sampler);
    }
    gl.activeTexture(gl.TEXTURE0 + 5);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, priorDrawFramebuffer);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, priorReadFramebuffer);
    gl.bindVertexArray(priorVertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, priorBuffer);
    gl.useProgram(priorProgram);
    gl.enable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.enable(gl.SCISSOR_TEST);
    gl.enable(gl.STENCIL_TEST);
    gl.disable(gl.DITHER);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.DST_ALPHA,
      gl.ONE_MINUS_DST_ALPHA,
    );
    gl.blendEquationSeparate(gl.FUNC_REVERSE_SUBTRACT, gl.FUNC_SUBTRACT);
    gl.clearColor(0.125, 0.25, 0.5, 0.75);
    gl.colorMask(true, false, true, false);
    gl.viewport(1, 2, 3, 4);

    const snapshotState = () => {
      const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
      const textureBindings = textureUnits.map(unit => {
        gl.activeTexture(unit);
        const bindings = [
          gl.getParameter(gl.TEXTURE_BINDING_2D),
          gl.getParameter(gl.TEXTURE_BINDING_3D),
          gl.getParameter(gl.SAMPLER_BINDING),
        ];
        return bindings;
      });
      gl.activeTexture(activeTexture);
      return {
        activeTexture,
        arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
        blend: gl.isEnabled(gl.BLEND),
        blendDstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA),
        blendDstRgb: gl.getParameter(gl.BLEND_DST_RGB),
        blendEquationAlpha: gl.getParameter(gl.BLEND_EQUATION_ALPHA),
        blendEquationRgb: gl.getParameter(gl.BLEND_EQUATION_RGB),
        blendSrcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA),
        blendSrcRgb: gl.getParameter(gl.BLEND_SRC_RGB),
        clearColor: Array.from(gl.getParameter(gl.COLOR_CLEAR_VALUE)),
        colorMask: Array.from(gl.getParameter(gl.COLOR_WRITEMASK)),
        cullFace: gl.isEnabled(gl.CULL_FACE),
        depthTest: gl.isEnabled(gl.DEPTH_TEST),
        dither: gl.isEnabled(gl.DITHER),
        drawFramebuffer: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
        program: gl.getParameter(gl.CURRENT_PROGRAM),
        rasterizerDiscard: gl.isEnabled(gl.RASTERIZER_DISCARD),
        readFramebuffer: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
        scissorTest: gl.isEnabled(gl.SCISSOR_TEST),
        stencilTest: gl.isEnabled(gl.STENCIL_TEST),
        textureBindings,
        vertexArray: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
        viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
      };
    };
    const before = snapshotState();

    const prototype = WebGL2RenderingContext.prototype;
    const resourceMethods = {
      buffer: ['createBuffer', 'deleteBuffer'],
      framebuffer: ['createFramebuffer', 'deleteFramebuffer'],
      program: ['createProgram', 'deleteProgram'],
      shader: ['createShader', 'deleteShader'],
      texture: ['createTexture', 'deleteTexture'],
      vertexArray: ['createVertexArray', 'deleteVertexArray'],
    };
    const created = {};
    const deleted = {};
    const originals = {};
    for (const [kind, [createName, deleteName]] of Object.entries(resourceMethods)) {
      created[kind] = new Set();
      deleted[kind] = new Set();
      originals[createName] = prototype[createName];
      originals[deleteName] = prototype[deleteName];
      prototype[createName] = function (...args) {
        const resource = Reflect.apply(originals[createName], this, args);
        if (this === gl && resource) created[kind].add(resource);
        return resource;
      };
      prototype[deleteName] = function (resource) {
        if (this === gl && created[kind].has(resource)) {
          deleted[kind].add(resource);
        }
        return Reflect.apply(originals[deleteName], this, [resource]);
      };
    }
    const originalCopyTexSubImage3D = prototype.copyTexSubImage3D;
    let copyCalls = 0;
    prototype.copyTexSubImage3D = function (...args) {
      if (this === gl) {
        copyCalls++;
        if (copyCalls === 2) {
          throw new Error('synthetic smoke slice publication failure');
        }
      }
      return Reflect.apply(originalCopyTexSubImage3D, this, args);
    };

    let failureMessage = null;
    let disposeResult = null;
    try {
      buildDensityTextureGPU(
        gl,
        new Float32Array([0, 0, 0, 0.25, -0.25, 0.25]),
        { gamma: 0.7, gridSize: 8 },
      );
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error);
    }
    disposeResult = disposeDensityPipelineResources(gl);
    const after = snapshotState();
    const resourcesBalanced = Object.fromEntries(
      Object.keys(resourceMethods).map(kind => [
        kind,
        created[kind].size === deleted[kind].size
          && [...created[kind]].every(resource => deleted[kind].has(resource)),
      ]),
    );

    prototype.copyTexSubImage3D = originalCopyTexSubImage3D;
    for (const [createName, original] of Object.entries(originals)) {
      prototype[createName] = original;
    }
    gl.useProgram(null);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    for (const unit of textureUnits) {
      gl.activeTexture(unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindTexture(gl.TEXTURE_3D, null);
      gl.bindSampler(unit - gl.TEXTURE0, null);
    }
    gl.deleteProgram(priorProgram);
    gl.deleteFramebuffer(priorDrawFramebuffer);
    gl.deleteFramebuffer(priorReadFramebuffer);
    gl.deleteBuffer(priorBuffer);
    gl.deleteVertexArray(priorVertexArray);
    for (const texture of priorTextures) gl.deleteTexture(texture);
    for (const sampler of priorSamplers) gl.deleteSampler(sampler);

    return {
      copyCalls,
      disposeResult,
      failureMessage,
      nonNullProgramRestored: (
        before.program === priorProgram && after.program === priorProgram
      ),
      resourcesBalanced,
      stateRestored: (
        before.activeTexture === after.activeTexture
        && before.arrayBuffer === after.arrayBuffer
        && before.blend === after.blend
        && before.blendDstAlpha === after.blendDstAlpha
        && before.blendDstRgb === after.blendDstRgb
        && before.blendEquationAlpha === after.blendEquationAlpha
        && before.blendEquationRgb === after.blendEquationRgb
        && before.blendSrcAlpha === after.blendSrcAlpha
        && before.blendSrcRgb === after.blendSrcRgb
        && before.clearColor.every((value, index) => value === after.clearColor[index])
        && before.colorMask.every((value, index) => value === after.colorMask[index])
        && before.cullFace === after.cullFace
        && before.depthTest === after.depthTest
        && before.dither === after.dither
        && before.drawFramebuffer === after.drawFramebuffer
        && before.program === after.program
        && before.rasterizerDiscard === after.rasterizerDiscard
        && before.readFramebuffer === after.readFramebuffer
        && before.scissorTest === after.scissorTest
        && before.stencilTest === after.stencilTest
        && before.textureBindings.every((bindings, unitIndex) => (
          bindings[0] === after.textureBindings[unitIndex][0]
          && bindings[1] === after.textureBindings[unitIndex][1]
          && bindings[2] === after.textureBindings[unitIndex][2]
        ))
        && before.vertexArray === after.vertexArray
        && before.viewport.every((value, index) => value === after.viewport[index])
      ),
      webglError: gl.getError(),
    };
  });

  expect(proof).toMatchObject({
    copyCalls: 2,
    disposeResult: true,
    failureMessage: 'synthetic smoke slice publication failure',
    nonNullProgramRestored: true,
    resourcesBalanced: {
      buffer: true,
      framebuffer: true,
      program: true,
      shader: true,
      texture: true,
      vertexArray: true,
    },
    stateRestored: true,
    webglError: 0,
  });
});

test('viewer publishes smoke atomically before completion and returns no owned texture', async ({
  page,
}) => {
  const browserErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      browserErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  await page.goto(CURRENT_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );

  const proof = await page.evaluate(async () => {
    const { getNotificationCenter } = await import(
      '/assets/js/app/notification-center.js'
    );
    const viewer = window._cellucidViewer;
    const canvas = document.querySelector('#glcanvas');
    const gl = canvas?.getContext('webgl2');
    if (!viewer || !(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Viewer smoke transaction fixture is unavailable');
    }
    const notifications = getNotificationCenter();
    const originalComplete = notifications.completeCalculation;
    let volumeVisibleAtCompletion = null;
    notifications.completeCalculation = function (...args) {
      volumeVisibleAtCompletion = viewer.hasSmokeVolume();
      return Reflect.apply(originalComplete, this, args);
    };
    let summary;
    try {
      summary = viewer.buildSmokeVolumeGPU(
        new Float32Array([0, 0, 0, 0.25, -0.25, 0.25]),
        { gamma: 0.7, gridSize: 8 },
      );
    } finally {
      notifications.completeCalculation = originalComplete;
    }

    const originalCopyTexSubImage3D = gl.copyTexSubImage3D;
    let copyCalls = 0;
    gl.copyTexSubImage3D = function (...args) {
      copyCalls++;
      if (copyCalls === 2) {
        throw new Error('synthetic viewer smoke replacement failure');
      }
      return Reflect.apply(originalCopyTexSubImage3D, this, args);
    };
    let replacementFailure = null;
    try {
      viewer.buildSmokeVolumeGPU(
        new Float32Array([-0.5, 0.5, 0, 0.5, -0.5, 0]),
        { gamma: 0.7, gridSize: 8 },
      );
    } catch (error) {
      replacementFailure = error instanceof Error
        ? error.message
        : String(error);
    } finally {
      gl.copyTexSubImage3D = originalCopyTexSubImage3D;
    }
    await new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    return {
      boundsMaxFrozen: Object.isFrozen(summary.boundsMax),
      boundsMinFrozen: Object.isFrozen(summary.boundsMin),
      hasOwnedTextureField: Object.hasOwn(summary, 'texture'),
      replacementFailure,
      summaryFrozen: Object.isFrozen(summary),
      summaryKeys: Object.keys(summary).sort(),
      summaryGridSize: summary.gridSize,
      volumeRetainedAfterFailure: viewer.hasSmokeVolume(),
      volumeVisibleAtCompletion,
      webglError: gl.getError(),
    };
  });

  expect(proof).toEqual({
    boundsMaxFrozen: true,
    boundsMinFrozen: true,
    hasOwnedTextureField: false,
    replacementFailure: 'synthetic viewer smoke replacement failure',
    summaryFrozen: true,
    summaryKeys: ['boundsMax', 'boundsMin', 'gridSize'],
    summaryGridSize: 8,
    volumeRetainedAfterFailure: true,
    volumeVisibleAtCompletion: true,
    webglError: 0,
  });
  expect(browserErrors).toEqual([]);
});

test('viewer invalidates smoke resources and requires reload after WebGL context loss', async ({
  page,
}) => {
  await page.goto(CURRENT_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
  const proof = await page.evaluate(async () => {
    const {
      invalidateDensityPipelineResources,
    } = await import('/assets/js/rendering/smoke-cloud/smoke-density.js');
    const canvas = document.querySelector('#glcanvas');
    const gl = canvas?.getContext('webgl2');
    const viewer = window._cellucidViewer;
    if (!(gl instanceof WebGL2RenderingContext) || !viewer) {
      throw new Error('Viewer smoke context lifecycle is unavailable');
    }
    const loseContext = gl.getExtension('WEBGL_lose_context');
    if (!loseContext) {
      throw new Error('Smoke context lifecycle requires WEBGL_lose_context');
    }
    viewer.buildSmokeVolumeGPU(new Float32Array([0, 0, 0]), {
      gamma: 0.7,
      gridSize: 8,
    });
    const lost = new Promise(resolve => {
      canvas.addEventListener('webglcontextlost', event => {
        resolve();
      }, { once: true });
    });
    loseContext.loseContext();
    await lost;
    return {
      cacheAlreadyInvalidated: !invalidateDensityPipelineResources(gl),
    };
  });

  expect(proof).toEqual({
    cacheAlreadyInvalidated: true,
  });
  await expect(page.locator('#cellucid-webgl-context-overlay')).toBeVisible();
  await expect(page.locator('#cellucid-webgl-context-overlay')).toContainText(
    'WebGL context lost. Reload required to continue.',
  );
  await expect(
    page.locator('#cellucid-webgl-context-overlay').getByRole('button', {
      name: 'Reload',
      exact: true,
    }),
  ).toBeVisible();
  const retirementFailure = await page.evaluate(async () => {
    try {
      await window._cellucidDispose();
      return null;
    } catch (error) {
      const serialize = value => ({
        errors: value instanceof AggregateError
          ? value.errors.map(serialize)
          : [],
        message: value?.message ?? String(value),
        name: value?.name ?? null,
      });
      return serialize(error);
    }
  });
  expect(retirementFailure).toBeNull();
});
