import assert from 'node:assert/strict';
import test from 'node:test';

import {
  drawKnnIndicator,
  drawProximityIndicator,
  findCellsInLasso,
  HighlightTools,
} from '../assets/js/rendering/highlight-renderer.js';

function identityMatrix() {
  const matrix = new Float32Array(16);
  matrix[0] = 1;
  matrix[5] = 1;
  matrix[10] = 1;
  matrix[15] = 1;
  return matrix;
}

function assertClose(actual, expected, tolerance = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}.`
  );
}

function createExactMat4() {
  return {
    create: identityMatrix,
    copy(out, source) {
      out.set(source);
      return out;
    },
    multiply(out, left, right) {
      const product = new Float32Array(16);
      for (let column = 0; column < 4; column++) {
        for (let row = 0; row < 4; row++) {
          let value = 0;
          for (let inner = 0; inner < 4; inner++) {
            value +=
              left[inner * 4 + row] *
              right[column * 4 + inner];
          }
          product[column * 4 + row] = value;
        }
      }
      out.set(product);
      return out;
    },
    perspective() {
      throw new Error('Highlight interactions must not rebuild a projection.');
    },
  };
}

function createCanvas(width, height) {
  const classes = new Set();
  return {
    classList: {
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      },
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width, height };
    },
    style: {
      cursor: 'default',
    },
  };
}

function createDrawingContext() {
  return {
    arcs: [],
    labels: [],
    beginPath() {},
    clearRect() {},
    closePath() {},
    fill() {},
    fillText(text, x, y) {
      this.labels.push({ text, x, y });
    },
    lineTo() {},
    moveTo() {},
    scale() {},
    setLineDash() {},
    setTransform() {},
    stroke() {},
    arc(x, y, radius) {
      this.arcs.push({ x, y, radius });
    },
  };
}

function createViewport({
  viewId,
  width,
  height,
  offsetX,
  offsetY = 0,
  localX = width / 2,
  localY = height / 2,
  projectionShift,
  projectionCenterNdcX = projectionShift,
  cameraForward = Float32Array.from([0, 0, -1]),
  cameraTargetRadius = 10,
}) {
  const projectionMatrix = identityMatrix();
  projectionMatrix[12] = projectionShift;
  return {
    viewId,
    vpWidth: width,
    vpHeight: height,
    vpOffsetX: offsetX,
    vpOffsetY: offsetY,
    vpLocalX: localX,
    vpLocalY: localY,
    vpAspect: width / height,
    projectionCenterNdcX,
    projectionMatrix,
    effectiveViewMatrix: identityMatrix(),
    cameraForward,
    cameraTargetRadius,
  };
}

function installBrowserPixelRatio(t) {
  const previousWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  t.after(() => {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  });
}

const overlayCases = [
  {
    name: 'open-sidebar shifted full view',
    canvasWidth: 100,
    viewportWidth: 100,
    offsetX: 0,
    projectionShift: 0.4,
    expectedCanvasX: 70,
  },
  {
    name: 'collapsed-sidebar centered full view',
    canvasWidth: 100,
    viewportWidth: 100,
    offsetX: 0,
    projectionShift: 0,
    expectedCanvasX: 50,
  },
  {
    name: 'shifted right grid pane',
    canvasWidth: 200,
    viewportWidth: 100,
    offsetX: 100,
    projectionShift: -0.2,
    expectedCanvasX: 140,
  },
];

for (const overlayCase of overlayCases) {
  test(
    `proximity, KNN, and lasso share the exact ${overlayCase.name} projection`,
    t => {
      installBrowserPixelRatio(t);
      const mat4 = createExactMat4();
      const modelMatrix = identityMatrix();
      const viewport = createViewport({
        viewId: 'clicked-pane',
        width: overlayCase.viewportWidth,
        height: 100,
        offsetX: overlayCase.offsetX,
        projectionShift: overlayCase.projectionShift,
      });
      const canvas = createCanvas(overlayCase.canvasWidth, 100);

      const proximityContext = createDrawingContext();
      drawProximityIndicator({
        canvas,
        lassoCtx: proximityContext,
        proximityCenter: {
          viewport,
          worldPos: [0, 0, 0],
        },
        proximityCurrentRadius: 0.1,
        mat4,
        viewMatrix: identityMatrix(),
        modelMatrix,
      });
      assertClose(proximityContext.arcs[0].x, overlayCase.expectedCanvasX);
      assert.equal(proximityContext.arcs[0].y, 50);

      const knnContext = createDrawingContext();
      drawKnnIndicator({
        canvas,
        lassoCtx: knnContext,
        knnSeedCell: {
          cellIndex: 0,
          viewport,
        },
        knnCurrentDegree: 0,
        mat4,
        viewMatrix: identityMatrix(),
        modelMatrix,
        viewPositions: Float32Array.from([0, 0, 0]),
      });
      assertClose(knnContext.arcs.at(-1).x, overlayCase.expectedCanvasX);
      assert.equal(knnContext.arcs.at(-1).y, 50);

      const selected = findCellsInLasso({
        lassoPath: [
          { x: overlayCase.expectedCanvasX - 3, y: 47 },
          { x: overlayCase.expectedCanvasX + 3, y: 47 },
          { x: overlayCase.expectedCanvasX + 3, y: 53 },
          { x: overlayCase.expectedCanvasX - 3, y: 53 },
        ],
        lassoViewContext: {
          viewId: viewport.viewId,
          viewport,
          viewMatrix: identityMatrix(),
        },
        mat4,
        modelMatrix,
        transparencyArray: Float32Array.from([1]),
        viewPositions: Float32Array.from([0, 0, 0]),
      });
      assert.deepEqual(selected, [0]);
    }
  );
}

test('unlocked grid proximity owns the clicked pane plane and scale for the full gesture', t => {
  installBrowserPixelRatio(t);
  const mat4 = createExactMat4();
  const clickedViewMatrix = identityMatrix();
  const sourceViewport = createViewport({
    viewId: 'non-focused-pane',
    width: 100,
    height: 100,
    offsetX: 100,
    localX: 25,
    localY: 50,
    projectionShift: -0.2,
    cameraForward: Float32Array.from([1, 0, 0]),
    cameraTargetRadius: 8,
  });
  sourceViewport.effectiveViewMatrix = clickedViewMatrix;

  const rayCalls = [];
  const lassoCtx = createDrawingContext();
  const canvas = createCanvas(200, 100);
  const focusedContext = {
    // The focused camera is deliberately orthogonal and materially farther away.
    eye: [0, 0, 10],
    target: [0, 0, 0],
    targetRadius: 1000,
    viewMatrix: identityMatrix(),
    modelMatrix: identityMatrix(),
  };
  const tools = Object.assign(Object.create(HighlightTools.prototype), {
    _unifiedCandidateSet: new Set([0]),
    _unifiedStepCount: 1,
    canvas,
    cellSelectionEnabled: false,
    getRenderContext: () => focusedContext,
    getViewPositions: viewId => {
      assert.equal(viewId, 'non-focused-pane');
      return Float32Array.from([0, 0, 0]);
    },
    getViewportInfoAtScreen: () => sourceViewport,
    highlightMode: 'none',
    isProximityDragging: false,
    knnEnabled: false,
    lassoCtx,
    lassoEnabled: false,
    mat4,
    pickCellAtScreen: () => -1,
    proximityCurrentRadius: 0,
    proximityEnabled: true,
    proximityPreviewCallback: null,
    screenToRay: (...args) => {
      rayCalls.push(args);
      return {
        origin: Float32Array.from([-5, 0, 0]),
        direction: Float32Array.from([1, 0, 0]),
      };
    },
  });

  let prevented = false;
  const handled = tools.handleMouseDown({
    altKey: true,
    button: 0,
    clientX: 125,
    clientY: 50,
    ctrlKey: false,
    metaKey: false,
    preventDefault() {
      prevented = true;
    },
    shiftKey: false,
  });

  assert.equal(handled, true);
  assert.equal(prevented, true);
  assert.deepEqual(tools.proximityCenter.worldPos, [0, 0, 0]);
  assert.equal(tools.proximityCenter.viewId, 'non-focused-pane');
  assert.notEqual(
    tools.proximityCenter.viewport.cameraForward,
    sourceViewport.cameraForward
  );
  assert.deepEqual(
    [...tools.proximityCenter.viewport.cameraForward],
    [1, 0, 0]
  );
  assert.deepEqual(rayCalls[0].slice(0, 5), [25, 50, 100, 100, 1]);
  assert.equal(rayCalls[0][5], clickedViewMatrix);
  assert.equal(rayCalls[0][6], -0.2);

  // Mutating the producer's object cannot alter the captured interaction.
  sourceViewport.projectionMatrix[12] = 0.8;
  sourceViewport.cameraForward.set([0, 1, 0]);
  sourceViewport.cameraTargetRadius = 800;

  assert.equal(
    tools.handleMouseMove({
      clientX: 155,
      clientY: 90,
    }),
    true
  );
  assert.equal(tools.proximityCurrentRadius, 0.4);
  assert.deepEqual(
    [...tools.proximityCenter.viewport.cameraForward],
    [1, 0, 0]
  );
  assert.equal(tools.proximityCenter.viewport.cameraTargetRadius, 8);
  assertClose(lassoCtx.arcs[0].x, 140);
  assert.equal(lassoCtx.arcs[0].y, 50);
});

test('highlight viewport interactions reject absent pane camera ownership', t => {
  installBrowserPixelRatio(t);
  const exact = createViewport({
    viewId: 'pane',
    width: 100,
    height: 100,
    offsetX: 0,
    projectionShift: 0,
  });
  const common = {
    canvas: createCanvas(100, 100),
    lassoCtx: createDrawingContext(),
    proximityCurrentRadius: 1,
    mat4: createExactMat4(),
    viewMatrix: identityMatrix(),
    modelMatrix: identityMatrix(),
  };

  const { cameraForward: _cameraForward, ...withoutForward } = exact;
  assert.throws(
    () => drawProximityIndicator({
      ...common,
      proximityCenter: {
        viewport: withoutForward,
        worldPos: [0, 0, 0],
      },
    }),
    /camera forward/
  );

  const { cameraTargetRadius: _cameraTargetRadius, ...withoutScale } = exact;
  assert.throws(
    () => drawProximityIndicator({
      ...common,
      proximityCenter: {
        viewport: withoutScale,
        worldPos: [0, 0, 0],
      },
    }),
    /camera target radius/
  );
});
