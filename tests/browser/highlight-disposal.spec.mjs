import { expect, test } from '@playwright/test';

const WEBGL_HARNESS = '/tests/browser/fixtures/webgl-harness.html';

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
