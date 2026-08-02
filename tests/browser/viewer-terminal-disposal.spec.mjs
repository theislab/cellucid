import { expect, test } from '@playwright/test';

import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=viewer-terminal-disposal-ci`;

test.beforeEach(async ({ page }) => {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
  await page.evaluate(async () => {
    const ui = window._cellucidUi;
    if (
      ui === null ||
      typeof ui !== 'object' ||
      typeof ui.destroy !== 'function'
    ) {
      throw new Error(
        'Viewer terminal tests require the application UI teardown owner.'
      );
    }
    await ui.destroy();
  });
});

test('real WebGL loss is a permanent owner fence with no restoration or disposal GL work', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const proof = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const canvas = document.querySelector('#glcanvas');
    const gl = viewer?.getGLContext();
    const renderer = viewer?.getHPRenderer();
    if (
      !viewer ||
      !(canvas instanceof HTMLCanvasElement) ||
      !(gl instanceof WebGL2RenderingContext) ||
      !renderer
    ) {
      throw new Error('Viewer context-loss ownership is unavailable.');
    }
    const loseContext = gl.getExtension('WEBGL_lose_context');
    if (!loseContext) {
      throw new Error(
        'Viewer context-loss ownership requires WEBGL_lose_context.',
      );
    }

    // Move through the public dimension contract to an as-yet unbuilt tree.
    // setDimensionLevel is intentionally lazy, so the same task can enqueue
    // projectile preparation and lose the context before the next frame
    // builds the 1D index.
    if (renderer.hasSpatialIndex(1)) {
      throw new Error(
        'Terminal projectile fixture unexpectedly prebuilt its 1D index.',
      );
    }
    viewer.setViewDimension('live', 1);
    const projectileCompletions = [];
    viewer.setProjectilesEnabled(true, result => {
      projectileCompletions.push({
        contextLostAtCompletion: gl.isContextLost(),
        message: result.message,
        status: result.status,
      });
    });

    const resizePrototype = ResizeObserver.prototype;
    const originalResizeDisconnect = resizePrototype.disconnect;
    let resizeDisconnectCalls = 0;
    resizePrototype.disconnect = function (...args) {
      resizeDisconnectCalls += 1;
      return Reflect.apply(originalResizeDisconnect, this, args);
    };

    const capturedRendererMutation = renderer.setAdaptiveLOD;
    const viewerMethodIdentities = {
      setCentroids: viewer.setCentroids,
      setPointSize: viewer.setPointSize,
    };
    let lossDefaultPrevented = null;
    const lost = new Promise(resolve => {
      canvas.addEventListener('webglcontextlost', event => {
        lossDefaultPrevented = event.defaultPrevented;
        resolve();
      }, { once: true });
    });
    loseContext.loseContext();
    await lost;
    const contextLostAfterEvent = gl.isContextLost();
    const resizeDisconnectCallsAfterLoss = resizeDisconnectCalls;

    const prototype = WebGL2RenderingContext.prototype;
    const interceptedMethodNames = [
      'bindBuffer',
      'bindFramebuffer',
      'bindTexture',
      'bindVertexArray',
      'deleteBuffer',
      'deleteFramebuffer',
      'deleteProgram',
      'deleteRenderbuffer',
      'deleteShader',
      'deleteTexture',
      'deleteTransformFeedback',
      'deleteVertexArray',
      'getError',
      'getParameter',
      'useProgram',
    ];
    const originalMethods = {};
    const glCalls = Object.fromEntries(
      interceptedMethodNames.map(name => [name, 0]),
    );
    for (const name of interceptedMethodNames) {
      originalMethods[name] = prototype[name];
      prototype[name] = function (...args) {
        if (this === gl) glCalls[name] += 1;
        return Reflect.apply(originalMethods[name], this, args);
      };
    }

    const terminalAttempts = {};
    const attempt = (name, operation) => {
      try {
        operation();
        terminalAttempts[name] = { message: null, name: null };
      } catch (error) {
        terminalAttempts[name] = {
          message: error.message,
          name: error.name,
        };
      }
    };
    attempt('setCentroids', () => {
      viewer.setCentroids({
        positions: new Float32Array([0, 0, 0]),
        colors: new Uint8Array([255, 0, 0, 255]),
        count: 1,
      });
    });
    attempt('setPointSize', () => {
      viewer.setPointSize(99);
    });
    attempt('capturedRendererMutation', () => {
      capturedRendererMutation(true);
    });
    attempt('rendererPropertyMutation', () => {
      renderer.forceLODLevel = 2;
    });

    viewer.start();
    viewer.resume();
    viewer.pause();
    const pausedAfterSafeControls = viewer.isPaused();
    const stableRendererFacade = viewer.getHPRenderer() === renderer;
    const stableGlDiagnostic = viewer.getGLContext() === gl;
    const methodIdentitiesStable =
      viewer.setCentroids === viewerMethodIdentities.setCentroids &&
      viewer.setPointSize === viewerMethodIdentities.setPointSize &&
      renderer.setAdaptiveLOD === capturedRendererMutation;

    const contextMenu = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    canvas.dispatchEvent(contextMenu);
    const repeatedLoss = new Event('webglcontextlost', {
      bubbles: false,
      cancelable: true,
    });
    canvas.dispatchEvent(repeatedLoss);

    await new Promise(resolve => setTimeout(resolve, 40));
    const overlayCount = document.querySelectorAll(
      '#cellucid-webgl-context-overlay',
    ).length;
    const glCallsBeforeDispose = Object.values(glCalls).reduce(
      (total, count) => total + count,
      0,
    );
    let disposeError = null;
    try {
      viewer.dispose();
    } catch (error) {
      disposeError = {
        message: error.message,
        name: error.name,
      };
    }
    const glCallsThroughDispose = Object.values(glCalls).reduce(
      (total, count) => total + count,
      0,
    );
    const lifecycle = {
      disposed: viewer.isDisposed(),
      paused: viewer.isPaused(),
      settled: viewer.isDisposalSettled(),
    };

    for (const name of interceptedMethodNames) {
      prototype[name] = originalMethods[name];
    }
    resizePrototype.disconnect = originalResizeDisconnect;
    return {
      contextLostAfterEvent,
      contextMenuDefaultPrevented: contextMenu.defaultPrevented,
      disposeError,
      glCalls,
      glCallsBeforeDispose,
      glCallsThroughDispose,
      lifecycle,
      lossDefaultPrevented,
      methodIdentitiesStable,
      overlayCount,
      pausedAfterSafeControls,
      projectileCompletions,
      repeatedLossDefaultPrevented: repeatedLoss.defaultPrevented,
      resizeDisconnectCallsAfterLoss,
      resizeDisconnectCalls,
      stableGlDiagnostic,
      stableRendererFacade,
      terminalAttempts,
    };
  });

  expect(proof.lossDefaultPrevented).toBe(false);
  expect(proof.contextLostAfterEvent).toBe(true);
  expect(proof.contextMenuDefaultPrevented).toBe(false);
  expect(proof.repeatedLossDefaultPrevented).toBe(false);
  expect(proof.resizeDisconnectCallsAfterLoss).toBeGreaterThanOrEqual(1);
  expect(proof.resizeDisconnectCalls).toBe(
    proof.resizeDisconnectCallsAfterLoss,
  );
  expect(proof.projectileCompletions).toHaveLength(1);
  const [projectileCompletion] = proof.projectileCompletions;
  // WEBGL_lose_context initiates loss, but engines do not promise that the
  // physical loss or its event beats an already-scheduled timer. A build may
  // linearize first; it must never publish ready after the context is lost.
  if (projectileCompletion.status === 'ready') {
    expect(projectileCompletion).toEqual({
      contextLostAtCompletion: false,
      message: null,
      status: 'ready',
    });
  } else {
    expect(projectileCompletion).toEqual({
      contextLostAtCompletion: true,
      message: 'Projectile preparation was cancelled because the WebGL context was lost.',
      status: 'cancelled',
    });
  }
  expect(proof.overlayCount).toBe(1);
  expect(proof.pausedAfterSafeControls).toBe(true);
  expect(proof.stableRendererFacade).toBe(true);
  expect(proof.stableGlDiagnostic).toBe(true);
  expect(proof.methodIdentitiesStable).toBe(true);
  expect(Object.keys(proof.terminalAttempts).sort()).toEqual([
    'capturedRendererMutation',
    'rendererPropertyMutation',
    'setCentroids',
    'setPointSize',
  ]);
  for (const [methodName, outcome] of Object.entries(
    proof.terminalAttempts,
  )) {
    expect(outcome.name, methodName).toBe('ViewerContextLostError');
    expect(outcome.message, methodName).toMatch(
      /unavailable after WebGL context loss/,
    );
  }
  expect(proof.glCallsBeforeDispose).toBe(0);
  expect(proof.disposeError).toBe(null);
  expect(proof.glCallsThroughDispose).toBe(0);
  expect(proof.glCalls).toEqual({
    bindBuffer: 0,
    bindFramebuffer: 0,
    bindTexture: 0,
    bindVertexArray: 0,
    deleteBuffer: 0,
    deleteFramebuffer: 0,
    deleteProgram: 0,
    deleteRenderbuffer: 0,
    deleteShader: 0,
    deleteTexture: 0,
    deleteTransformFeedback: 0,
    deleteVertexArray: 0,
    getError: 0,
    getParameter: 0,
    useProgram: 0,
  });
  expect(proof.lifecycle).toEqual({
    disposed: true,
    paused: true,
    settled: true,
  });
  expect(pageErrors).toEqual([]);
});

test('physical context loss cancels projectile readiness before its event task', async ({
  page,
}) => {
  const completion = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const gl = viewer?.getGLContext();
    const renderer = viewer?.getHPRenderer();
    if (
      !viewer ||
      !(gl instanceof WebGL2RenderingContext) ||
      !renderer
    ) {
      throw new Error('Projectile physical-loss fencing is unavailable.');
    }
    if (renderer.hasSpatialIndex(1)) {
      throw new Error(
        'Physical-loss projectile fixture unexpectedly prebuilt its 1D index.',
      );
    }
    viewer.setViewDimension('live', 1);

    const prototype = WebGL2RenderingContext.prototype;
    const originalIsContextLost = prototype.isContextLost;
    let reportPhysicalLoss = false;
    prototype.isContextLost = function (...args) {
      if (this === gl && reportPhysicalLoss) return true;
      return Reflect.apply(originalIsContextLost, this, args);
    };
    try {
      const settled = new Promise(resolve => {
        viewer.setProjectilesEnabled(true, resolve);
      });
      // Model the engine-visible interval where physical loss is queryable but
      // webglcontextlost has not yet advanced the viewer's logical generation.
      reportPhysicalLoss = true;
      return await settled;
    } finally {
      prototype.isContextLost = originalIsContextLost;
    }
  });

  expect(completion).toEqual({
    message: 'Projectile preparation was cancelled because the WebGL context was lost.',
    status: 'cancelled',
  });
});

test('velocity reset detaches before hostile retirement and recreates the same ID', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const proof = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const { dimensionLevel, fieldData } = (() => {
      const cellCount = viewer.getPointCount();
      const components = viewer.getViewDimension('live');
      const vectors = new Float32Array(cellCount * components);
      vectors.fill(0.01);
      return {
        dimensionLevel: components,
        fieldData: {
          cellCount,
          components,
          maxMagnitude: 0.02,
          vectors,
        },
      };
    })();
    const prototype = WebGL2RenderingContext.prototype;
    const originalCreateProgram = prototype.createProgram;
    const originalDeleteProgram = prototype.deleteProgram;
    const velocityPrograms = new WeakSet();
    let capturePrograms = true;
    prototype.createProgram = function (...args) {
      const program = Reflect.apply(originalCreateProgram, this, args);
      if (capturePrograms && program !== null) velocityPrograms.add(program);
      return program;
    };
    viewer.setVectorFieldData(
      'retry_field',
      dimensionLevel,
      fieldData,
    );
    capturePrograms = false;

    let rejected = false;
    prototype.deleteProgram = function (program) {
      if (!rejected && velocityPrograms.has(program)) {
        rejected = true;
        throw new Error('synthetic velocity reset retirement failure');
      }
      return Reflect.apply(originalDeleteProgram, this, [program]);
    };
    let firstError = null;
    try {
      viewer.resetVectorFieldOverlay();
    } catch (error) {
      firstError = {
        message: error.message,
        name: error.name,
      };
    }
    const detachedAfterFailure = !viewer.hasVectorFieldForDimension(
      'retry_field',
      dimensionLevel,
    );
    viewer.resetVectorFieldOverlay();

    capturePrograms = true;
    viewer.setVectorFieldData(
      'retry_field',
      dimensionLevel,
      fieldData,
    );
    capturePrograms = false;
    const recreated = viewer.hasVectorFieldForDimension(
      'retry_field',
      dimensionLevel,
    );
    prototype.createProgram = originalCreateProgram;
    prototype.deleteProgram = originalDeleteProgram;
    return {
      detachedAfterFailure,
      firstError,
      glError: viewer.getGLContext().getError(),
      recreated,
      rejected,
    };
  });

  expect(proof.rejected).toBe(true);
  expect(proof.firstError?.name).toMatch(/Error/);
  expect(proof.firstError?.message).toMatch(
    /synthetic velocity reset retirement failure/,
  );
  expect(proof.detachedAfterFailure).toBe(true);
  expect(proof.recreated).toBe(true);
  expect(proof.glError).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('viewer disposal fences RAF, attempts all owners, and retries only failures', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const proof = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const renderer = viewer.getHPRenderer();
    const canvas = document.querySelector('#glcanvas');
    const { dimensionLevel, fieldData } = (() => {
      const cellCount = viewer.getPointCount();
      const components = viewer.getViewDimension('live');
      const vectors = new Float32Array(cellCount * components);
      vectors.fill(0.01);
      return {
        dimensionLevel: components,
        fieldData: {
          cellCount,
          components,
          maxMagnitude: 0.02,
          vectors,
        },
      };
    })();
    const dataPositions = viewer.getPositions();
    const dataColors = viewer.getColors();
    const dataTransparency = new Float32Array(
      viewer.getViewTransparency('live'),
    );
    const snapshotPayload = state.getSnapshotPayload();
    const snapshotConfig = {
      label: 'Terminal resurrection candidate',
      fieldKey: snapshotPayload.fieldKey,
      fieldKind: snapshotPayload.fieldKind,
      colors: snapshotPayload.colors,
      transparency: snapshotPayload.transparency,
      centroidPositions: snapshotPayload.centroidPositions,
      centroidColors: snapshotPayload.centroidColors,
      dimensionLevel,
      sourceViewId: 'live',
      meta: { filtersText: snapshotPayload.filtersText },
      cameraState: viewer.getViewCameraState('live'),
    };
    const edgeData = {
      sources: Uint32Array.from([0]),
      destinations: Uint32Array.from([1]),
      weights: Float64Array.from([1]),
      nEdges: 1,
      nCells: dataPositions.length / 3,
    };
    const highlightData = new Uint8Array(dataPositions.length / 3);
    highlightData[0] = 255;
    const guardedMethodNames = [
      'buildSmokeVolumeGPU',
      'createSnapshotView',
      'setCentroidLabels',
      'setData',
      'setVectorFieldData',
      'setupEdgesV2',
      'updateHighlight',
    ];
    const guardedMethodIdentities = Object.fromEntries(
      guardedMethodNames.map(name => [name, viewer[name]]),
    );
    const prototype = WebGL2RenderingContext.prototype;
    const originalCreateProgram = prototype.createProgram;
    const originalDeleteProgram = prototype.deleteProgram;
    const originalDrawArrays = prototype.drawArrays;
    const originalDrawElements = prototype.drawElements;
    const eventTargetPrototype = EventTarget.prototype;
    const originalRemoveEventListener =
      eventTargetPrototype.removeEventListener;
    const velocityPrograms = new WeakSet();
    const deletionCounts = new Map();
    let capturePrograms = true;
    let contextMenuRemovalAttempts = 0;
    let drawCalls = 0;
    let rejectedListenerRemoval = false;

    prototype.createProgram = function (...args) {
      const program = Reflect.apply(originalCreateProgram, this, args);
      if (capturePrograms && program !== null) velocityPrograms.add(program);
      return program;
    };
    viewer.setVectorFieldData(
      'terminal_field',
      dimensionLevel,
      fieldData,
    );
    capturePrograms = false;
    prototype.drawArrays = function (...args) {
      drawCalls += 1;
      return Reflect.apply(originalDrawArrays, this, args);
    };
    prototype.drawElements = function (...args) {
      drawCalls += 1;
      return Reflect.apply(originalDrawElements, this, args);
    };

    let rejectedProgram = null;
    prototype.deleteProgram = function (program) {
      if (velocityPrograms.has(program)) {
        deletionCounts.set(
          program,
          (deletionCounts.get(program) ?? 0) + 1,
        );
        if (rejectedProgram === null) {
          rejectedProgram = program;
          throw new Error(
            'synthetic terminal velocity program retirement failure',
          );
        }
      }
      return Reflect.apply(originalDeleteProgram, this, [program]);
    };
    eventTargetPrototype.removeEventListener = function (
      event,
      handler,
      options,
    ) {
      if (this === canvas && event === 'contextmenu') {
        contextMenuRemovalAttempts += 1;
        if (!rejectedListenerRemoval) {
          rejectedListenerRemoval = true;
          throw new Error(
            'synthetic terminal event-listener retirement failure',
          );
        }
      }
      return Reflect.apply(
        originalRemoveEventListener,
        this,
        [event, handler, options],
      );
    };

    let firstError = null;
    try {
      viewer.dispose();
    } catch (error) {
      const messages = [];
      const collect = value => {
        messages.push(value.message);
        if (value instanceof AggregateError) {
          value.errors.forEach(collect);
        }
      };
      collect(error);
      firstError = {
        messages,
        name: error.name,
      };
    }
    const drawsAtFence = drawCalls;
    const survivingContextMenu = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    canvas.dispatchEvent(survivingContextMenu);
    const survivingHandlerFenced = !survivingContextMenu.defaultPrevented;
    const lifecycleAfterFirstAttempt = {
      disposed: viewer.isDisposed(),
      paused: viewer.isPaused(),
      settled: viewer.isDisposalSettled(),
      stableGlDiagnostic: viewer.getGLContext() ===
        document.querySelector('#glcanvas').getContext('webgl2'),
      stableRendererDiagnostic: viewer.getHPRenderer() === renderer,
    };

    const allocatorNames = [
      'createBuffer',
      'createFramebuffer',
      'createProgram',
      'createRenderbuffer',
      'createTexture',
      'createVertexArray',
    ];
    const originalAllocators = {};
    const allocationCalls = Object.fromEntries(
      allocatorNames.map(name => [name, 0]),
    );
    for (const name of allocatorNames) {
      originalAllocators[name] = prototype[name];
      prototype[name] = function (...args) {
        allocationCalls[name] += 1;
        return Reflect.apply(originalAllocators[name], this, args);
      };
    }

    const originalRequestAnimationFrame = window.requestAnimationFrame;
    let postFenceRafRequests = 0;
    window.requestAnimationFrame = function (...args) {
      postFenceRafRequests += 1;
      return Reflect.apply(originalRequestAnimationFrame, window, args);
    };

    const labelLayer = document.querySelector('#label-layer');
    const labelChildrenAtFence = labelLayer?.childElementCount ?? 0;
    let labelLayerMutations = 0;
    const labelObserver = new MutationObserver(records => {
      labelLayerMutations += records.length;
    });
    if (labelLayer) {
      labelObserver.observe(labelLayer, {
        attributes: true,
        childList: true,
        subtree: true,
      });
    }
    const terminalLabel = document.createElement('div');
    terminalLabel.textContent = 'must never publish';
    const terminalAttempts = {};
    const attemptTerminalMutation = (name, operation) => {
      try {
        operation();
        terminalAttempts[name] = {
          message: null,
          name: null,
        };
      } catch (error) {
        terminalAttempts[name] = {
          message: error.message,
          name: error.name,
        };
      }
    };
    attemptTerminalMutation('setData', () => {
      viewer.setData({
        positions: dataPositions,
        colors: dataColors,
        transparency: dataTransparency,
        dimensionLevel,
      });
    });
    attemptTerminalMutation('createSnapshotView', () => {
      viewer.createSnapshotView(snapshotConfig);
    });
    attemptTerminalMutation('setupEdgesV2', () => {
      viewer.setupEdgesV2(edgeData, dataPositions);
    });
    attemptTerminalMutation('buildSmokeVolumeGPU', () => {
      viewer.buildSmokeVolumeGPU(
        new Float32Array([0, 0, 0]),
        { gamma: 0.7, gridSize: 8 },
      );
    });
    attemptTerminalMutation('updateHighlight', () => {
      viewer.updateHighlight(highlightData, [0]);
    });
    attemptTerminalMutation('setVectorFieldData', () => {
      viewer.setVectorFieldData(
        'terminal_field',
        dimensionLevel,
        fieldData,
      );
    });
    attemptTerminalMutation('setCentroidLabels', () => {
      viewer.setCentroidLabels([
        { el: terminalLabel, position: [0, 0, 0] },
      ], 'live');
    });

    viewer.start();
    viewer.resume();
    viewer.pause();
    await new Promise(resolve => setTimeout(resolve, 50));
    const drawsAfterRestartAttempt = drawCalls;
    const postFenceAllocations = Object.values(allocationCalls).reduce(
      (total, count) => total + count,
      0,
    );
    const guardedMethodIdentitiesStable = guardedMethodNames.every(
      name => viewer[name] === guardedMethodIdentities[name],
    );
    const labelChildrenAfterAttempts =
      labelLayer?.childElementCount ?? 0;
    labelObserver.disconnect();
    const rendererRetiredAfterFirstAttempt =
      renderer.vao === null &&
      renderer.pointCount === 0 &&
      Object.values(renderer.buffers ?? {}).every(buffer => buffer === null) &&
      Object.values(renderer.programs ?? {}).every(program => program === null);
    const staleLassoCount =
      document.querySelectorAll('.lasso-overlay, #lasso-overlay').length;
    const staleTitleCount =
      document.querySelector('#view-title-layer')?.childElementCount ?? 0;
    const staleLabelCount =
      document.querySelector('#label-layer')?.childElementCount ?? 0;

    let secondError = null;
    try {
      viewer.dispose();
    } catch (error) {
      secondError = error.message;
    }
    const lifecycleAfterRetry = {
      disposed: viewer.isDisposed(),
      paused: viewer.isPaused(),
      settled: viewer.isDisposalSettled(),
      stableGlDiagnostic: viewer.getGLContext() ===
        document.querySelector('#glcanvas').getContext('webgl2'),
      stableRendererDiagnostic: viewer.getHPRenderer() === renderer,
    };
    const deletionAttempts = Array.from(deletionCounts.values());
    for (const name of allocatorNames) {
      prototype[name] = originalAllocators[name];
    }
    window.requestAnimationFrame = originalRequestAnimationFrame;
    eventTargetPrototype.removeEventListener =
      originalRemoveEventListener;
    prototype.createProgram = originalCreateProgram;
    prototype.deleteProgram = originalDeleteProgram;
    prototype.drawArrays = originalDrawArrays;
    prototype.drawElements = originalDrawElements;
    return {
      drawsAfterRestartAttempt,
      drawsAtFence,
      firstError,
      glError: viewer.getGLContext().getError(),
      guardedMethodIdentitiesStable,
      contextMenuRemovalAttempts,
      labelChildrenAfterAttempts,
      labelChildrenAtFence,
      labelLayerMutations,
      lifecycleAfterFirstAttempt,
      lifecycleAfterRetry,
      postFenceAllocations,
      postFenceRafRequests,
      rejectedAttempts: deletionCounts.get(rejectedProgram),
      rendererRetiredAfterFirstAttempt,
      secondError,
      staleLabelCount,
      staleLassoCount,
      staleTitleCount,
      successfulProgramMaxAttempts: Math.max(
        0,
        ...deletionAttempts.filter(count => count !== 2),
      ),
      survivingHandlerFenced,
      terminalAttempts,
      terminalLabelConnected: terminalLabel.isConnected,
    };
  });

  expect(proof.firstError?.name).toBe('AggregateError');
  expect(proof.firstError?.messages.join('\n')).toMatch(
    /synthetic terminal velocity program retirement failure/,
  );
  expect(proof.firstError?.messages.join('\n')).toMatch(
    /synthetic terminal event-listener retirement failure/,
  );
  expect(proof.rendererRetiredAfterFirstAttempt).toBe(true);
  expect(proof.drawsAfterRestartAttempt).toBe(proof.drawsAtFence);
  expect(proof.lifecycleAfterFirstAttempt).toEqual({
    disposed: true,
    paused: true,
    settled: false,
    stableGlDiagnostic: true,
    stableRendererDiagnostic: true,
  });
  expect(proof.lifecycleAfterRetry).toEqual({
    disposed: true,
    paused: true,
    settled: true,
    stableGlDiagnostic: true,
    stableRendererDiagnostic: true,
  });
  expect(proof.guardedMethodIdentitiesStable).toBe(true);
  expect(proof.survivingHandlerFenced).toBe(true);
  expect(proof.contextMenuRemovalAttempts).toBe(2);
  expect(proof.postFenceAllocations).toBe(0);
  expect(proof.postFenceRafRequests).toBe(0);
  expect(proof.labelLayerMutations).toBe(0);
  expect(proof.labelChildrenAfterAttempts).toBe(
    proof.labelChildrenAtFence,
  );
  expect(proof.terminalLabelConnected).toBe(false);
  expect(Object.keys(proof.terminalAttempts).sort()).toEqual([
    'buildSmokeVolumeGPU',
    'createSnapshotView',
    'setCentroidLabels',
    'setData',
    'setVectorFieldData',
    'setupEdgesV2',
    'updateHighlight',
  ]);
  for (const [methodName, outcome] of Object.entries(
    proof.terminalAttempts,
  )) {
    expect(outcome.name, methodName).toBe('ViewerDisposedError');
    expect(outcome.message, methodName).toContain(
      `Viewer method "${methodName}" is unavailable after dispose()`,
    );
  }
  expect(proof.staleLassoCount).toBe(0);
  expect(proof.staleTitleCount).toBe(0);
  expect(proof.staleLabelCount).toBe(0);
  expect(proof.secondError).toBe(null);
  expect(proof.rejectedAttempts).toBe(2);
  expect(proof.successfulProgramMaxAttempts).toBeLessThanOrEqual(1);
  expect(proof.glError).toBe(0);
  expect(pageErrors).toEqual([]);
});
