import { expect, test } from '@playwright/test';

const WEBGL_HARNESS = '/tests/browser/fixtures/webgl-harness.html';

test('lasso backing store follows DPR-only changes and retires every media generation', async ({
  page,
}) => {
  await page.goto(WEBGL_HARNESS);

  const proof = await page.evaluate(async () => {
    const { createLassoOverlay } = await import(
      '/assets/js/rendering/highlight-renderer.js'
    );
    let dpr = 1;
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      get: () => dpr,
    });
    const mediaGenerations = [];
    window.matchMedia = query => {
      const listeners = new Set();
      const generation = {
        emit() {
          for (const listener of [...listeners]) {
            listener({ matches: false, media: query });
          }
        },
        get listenerCount() {
          return listeners.size;
        },
        query,
      };
      mediaGenerations.push(generation);
      return {
        matches: true,
        media: query,
        addEventListener(type, listener) {
          if (type === 'change') listeners.add(listener);
        },
        removeEventListener(type, listener) {
          if (type === 'change') listeners.delete(listener);
        },
      };
    };
    class FakeResizeObserver {
      constructor(callback) {
        this.callback = callback;
        this.disconnected = false;
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    }
    window.ResizeObserver = FakeResizeObserver;

    const parent = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () => ({
      bottom: 10,
      height: 10,
      left: 0,
      right: 20,
      top: 0,
      width: 20,
      x: 0,
      y: 0,
    });
    parent.appendChild(canvas);
    document.body.appendChild(parent);
    const overlay = createLassoOverlay(canvas);
    const initial = {
      height: overlay.lassoCanvas.height,
      listeners: mediaGenerations.map(item => item.listenerCount),
      queries: mediaGenerations.map(item => item.query),
      width: overlay.lassoCanvas.width,
    };

    dpr = 2;
    mediaGenerations[0].emit();
    const afterDprChange = {
      height: overlay.lassoCanvas.height,
      listeners: mediaGenerations.map(item => item.listenerCount),
      queries: mediaGenerations.map(item => item.query),
      width: overlay.lassoCanvas.width,
    };
    overlay.resizeSubscription.disconnect();
    dpr = 3;
    mediaGenerations.at(-1).emit();
    const afterDisconnect = {
      height: overlay.lassoCanvas.height,
      listeners: mediaGenerations.map(item => item.listenerCount),
      width: overlay.lassoCanvas.width,
    };
    overlay.lassoCanvas.remove();
    return {
      afterDisconnect,
      afterDprChange,
      initial,
    };
  });

  expect(proof).toEqual({
    initial: {
      height: 10,
      listeners: [1],
      queries: ['(resolution: 1dppx)'],
      width: 20,
    },
    afterDprChange: {
      height: 20,
      listeners: [0, 1],
      queries: [
        '(resolution: 1dppx)',
        '(resolution: 2dppx)',
      ],
      width: 40,
    },
    afterDisconnect: {
      height: 20,
      listeners: [0, 0],
      width: 40,
    },
  });
});

test('lasso DPR-listener construction rolls back its observer, DOM, and parent lease', async ({
  page,
}) => {
  await page.goto(WEBGL_HARNESS);

  const proof = await page.evaluate(async () => {
    const { createLassoOverlay } = await import(
      '/assets/js/rendering/highlight-renderer.js'
    );
    let disconnectCalls = 0;
    class FakeResizeObserver {
      observe() {}
      disconnect() {
        disconnectCalls++;
      }
    }
    window.ResizeObserver = FakeResizeObserver;
    window.matchMedia = () => ({
      addEventListener() {
        throw new Error('synthetic DPR-listener setup failure');
      },
      removeEventListener() {},
    });
    const parent = document.createElement('div');
    const canvas = document.createElement('canvas');
    parent.appendChild(canvas);
    document.body.appendChild(parent);
    let failure = null;
    try {
      createLassoOverlay(canvas);
    } catch (error) {
      failure = {
        message: error.message,
        name: error.name,
      };
    }
    return {
      disconnectCalls,
      failure,
      overlayCount: parent.querySelectorAll('#lasso-overlay').length,
      parentPosition: parent.style.position,
    };
  });

  expect(proof).toEqual({
    disconnectCalls: 1,
    failure: {
      message: 'synthetic DPR-listener setup failure',
      name: 'Error',
    },
    overlayCount: 0,
    parentPosition: '',
  });
});

test('lasso DPR-listener disposal fences callbacks and retries only retained cleanup', async ({
  page,
}) => {
  await page.goto(WEBGL_HARNESS);

  const proof = await page.evaluate(async () => {
    const { createLassoOverlay } = await import(
      '/assets/js/rendering/highlight-renderer.js'
    );
    let dpr = 1;
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      get: () => dpr,
    });
    let listener = null;
    let removeCalls = 0;
    window.matchMedia = () => ({
      addEventListener(type, candidate) {
        if (type === 'change') listener = candidate;
      },
      removeEventListener(type, candidate) {
        if (type !== 'change' || candidate !== listener) return;
        removeCalls++;
        if (removeCalls === 1) {
          throw new Error('synthetic DPR-listener cleanup failure');
        }
        listener = null;
      },
    });
    let disconnectCalls = 0;
    class FakeResizeObserver {
      observe() {}
      disconnect() {
        disconnectCalls++;
      }
    }
    window.ResizeObserver = FakeResizeObserver;
    const parent = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () => ({
      height: 10,
      width: 20,
    });
    parent.appendChild(canvas);
    document.body.appendChild(parent);
    const overlay = createLassoOverlay(canvas);
    const retainedListener = listener;

    let firstFailure = null;
    try {
      overlay.resizeSubscription.disconnect();
    } catch (error) {
      firstFailure = {
        messages: error.errors?.map(item => item.message) ?? [],
        name: error.name,
      };
    }
    dpr = 2;
    retainedListener({ matches: false });
    const fencedSize = [
      overlay.lassoCanvas.width,
      overlay.lassoCanvas.height,
    ];
    overlay.resizeSubscription.disconnect();
    overlay.lassoCanvas.remove();
    return {
      disconnectCalls,
      fencedSize,
      firstFailure,
      listenerDetached: listener === null,
      removeCalls,
    };
  });

  expect(proof).toEqual({
    disconnectCalls: 1,
    fencedSize: [20, 10],
    firstFailure: {
      messages: ['synthetic DPR-listener cleanup failure'],
      name: 'AggregateError',
    },
    listenerDetached: true,
    removeCalls: 2,
  });
});

test('highlight teardown releases DOM, observer, callbacks, and GPU ownership retryably', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', error => {
    pageErrors.push(error.stack || error.message);
  });
  await page.goto(WEBGL_HARNESS);

  const proof = await page.evaluate(async () => {
    const { HighlightTools } = await import(
      '/assets/js/rendering/highlight-renderer.js'
    );
    const parent = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    canvas.style.width = '16px';
    canvas.style.height = '16px';
    canvas.style.cursor = 'help';
    parent.appendChild(canvas);
    document.body.appendChild(parent);
    const gl = canvas.getContext('webgl2');
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Highlight disposal proof requires WebGL2.');
    }

    const resizePrototype = ResizeObserver.prototype;
    const originalDisconnect = resizePrototype.disconnect;
    let disconnectCalls = 0;
    resizePrototype.disconnect = function () {
      disconnectCalls++;
      return Reflect.apply(originalDisconnect, this, []);
    };

    const tools = new HighlightTools({
      gl,
      canvas,
      hpRenderer: {},
      mat4: {},
      vec3: {},
      pickCellAtScreen: () => -1,
      screenToRay: () => null,
      getViewportInfoAtScreen: () => null,
      getRenderContext: () => null,
      getNavigationState: () => ({
        navigationMode: 'orbit',
        isDragging: false,
      }),
      getViewPositions: () => new Float32Array(),
      getViewTransparency: () => new Float32Array(),
      getSpatialQueryOwner: () => ({}),
    });
    const program = tools.highlightRenderer.program;
    const lassoCanvas = tools.lassoCanvas;
    const parentPositionWhileOwned = parent.style.position;
    const callback = () => {};
    tools.setCellSelectionCallback(callback);
    tools.setSelectionPreviewCallback(callback);
    tools.setSelectionStepCallback(callback);
    tools.setLassoCallback(callback);
    tools.setLassoPreviewCallback(callback);
    tools.setLassoStepCallback(callback);
    tools.setProximityCallback(callback);
    tools.setProximityPreviewCallback(callback);
    tools.setProximityStepCallback(callback);
    tools.setKnnCallback(callback);
    tools.setKnnPreviewCallback(callback);
    tools.setKnnStepCallback(callback);
    tools.setKnnEdgeLoadCallback(callback);
    tools.setHighlightMode('continuous');
    tools.setLassoEnabled(true);
    tools.setProximityEnabled(true);
    tools.setKnnEnabled(true);
    canvas.classList.add(
      'lassoing',
      'proximity-dragging',
      'knn-dragging',
      'selecting',
      'selecting-continuous',
    );
    canvas.style.cursor = 'crosshair';

    const glPrototype = WebGL2RenderingContext.prototype;
    const originalDeleteProgram = glPrototype.deleteProgram;
    let deleteProgramCalls = 0;
    let rejectFirstProgramDelete = true;
    glPrototype.deleteProgram = function (candidate) {
      if (this === gl && candidate === program) {
        deleteProgramCalls++;
        if (rejectFirstProgramDelete) {
          rejectFirstProgramDelete = false;
          throw new Error('synthetic browser highlight program failure');
        }
      }
      return Reflect.apply(originalDeleteProgram, this, [candidate]);
    };

    let firstFailure = null;
    let firstState;
    let secondResult;
    let thirdResult;
    try {
      try {
        tools.dispose();
      } catch (error) {
        firstFailure = {
          message: error.message,
          name: error.name,
          nestedMessages: error.errors?.map(item => item.message) ?? [],
        };
      }
      firstState = {
        callbacksDetached:
          tools.cellSelectionCallback === null &&
          tools.lassoCallback === null &&
          tools.proximityCallback === null &&
          tools.knnCallback === null &&
          tools.pickCellAtScreen === null &&
          tools.getViewPositions === null,
        canvasDetached: tools.canvas === null,
        classes: [...canvas.classList],
        cursor: canvas.style.cursor,
        disconnectCalls,
        lassoConnected: lassoCanvas.isConnected,
        overlayCount: parent.querySelectorAll('#lasso-overlay').length,
        parentPosition: parent.style.position,
        pendingPrograms:
          tools._disposeState?.renderer?._pendingProgramDeletes?.size ?? -1,
        rendererDetached: tools.highlightRenderer === null,
      };
      secondResult = tools.dispose();
      thirdResult = tools.dispose();
    } finally {
      glPrototype.deleteProgram = originalDeleteProgram;
      resizePrototype.disconnect = originalDisconnect;
    }

    return {
      deleteProgramCalls,
      disconnectCalls,
      firstFailure,
      firstState,
      parentPositionWhileOwned,
      programDeleted: !gl.isProgram(program),
      secondResult,
      thirdResult,
    };
  });

  expect(proof.parentPositionWhileOwned).toBe('relative');
  expect(proof.firstFailure).toEqual({
    message: 'HighlightTools disposal retains 1 pending owner failure(s).',
    name: 'AggregateError',
    nestedMessages: [
      'HighlightRenderer disposal retains 1 pending resource failure(s).',
    ],
  });
  expect(proof.firstState).toEqual({
    callbacksDetached: true,
    canvasDetached: true,
    classes: [],
    cursor: 'help',
    disconnectCalls: 1,
    lassoConnected: false,
    overlayCount: 0,
    parentPosition: '',
    pendingPrograms: 1,
    rendererDetached: true,
  });
  expect(proof.deleteProgramCalls).toBe(2);
  expect(proof.disconnectCalls).toBe(1);
  expect(proof.programDeleted).toBe(true);
  expect(proof.secondResult).toBe(true);
  expect(proof.thirdResult).toBe(false);
  expect(pageErrors).toEqual([]);
});

test('coexisting highlight overlays retain their shared parent positioning until the last owner', async ({
  page,
}) => {
  await page.goto(WEBGL_HARNESS);

  const proof = await page.evaluate(async () => {
    const { HighlightTools } = await import(
      '/assets/js/rendering/highlight-renderer.js'
    );
    const parent = document.createElement('div');
    const canvases = [
      document.createElement('canvas'),
      document.createElement('canvas'),
    ];
    for (const canvas of canvases) {
      canvas.width = 8;
      canvas.height = 8;
      parent.appendChild(canvas);
    }
    document.body.appendChild(parent);

    const makeTools = canvas => {
      const gl = canvas.getContext('webgl2');
      if (!(gl instanceof WebGL2RenderingContext)) {
        throw new Error('Shared-parent highlight proof requires WebGL2.');
      }
      return new HighlightTools({
        gl,
        canvas,
        hpRenderer: {},
        mat4: {},
        vec3: {},
        pickCellAtScreen: () => -1,
        screenToRay: () => null,
        getViewportInfoAtScreen: () => null,
        getRenderContext: () => null,
        getNavigationState: () => ({
          navigationMode: 'orbit',
          isDragging: false,
        }),
        getViewPositions: () => new Float32Array(),
        getViewTransparency: () => new Float32Array(),
        getSpatialQueryOwner: () => ({}),
      });
    };
    const first = makeTools(canvases[0]);
    const second = makeTools(canvases[1]);
    const afterCreate = {
      overlayCount: parent.querySelectorAll('#lasso-overlay').length,
      position: parent.style.position,
    };
    first.dispose();
    const afterFirst = {
      overlayCount: parent.querySelectorAll('#lasso-overlay').length,
      position: parent.style.position,
    };
    second.dispose();
    const afterSecond = {
      overlayCount: parent.querySelectorAll('#lasso-overlay').length,
      position: parent.style.position,
    };
    return { afterCreate, afterFirst, afterSecond };
  });

  expect(proof).toEqual({
    afterCreate: {
      overlayCount: 2,
      position: 'relative',
    },
    afterFirst: {
      overlayCount: 1,
      position: 'relative',
    },
    afterSecond: {
      overlayCount: 0,
      position: '',
    },
  });
});
