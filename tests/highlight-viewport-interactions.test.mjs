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
  const panePositions = Float32Array.from([0, 0, 0]);
  const paneTransparency = Float32Array.of(1);
  const paneOwner = {
    viewId: 'non-focused-pane',
    positions: panePositions,
    publishedPositions: panePositions,
    transparency: paneTransparency,
    dimensionLevel: 3,
    spatialIndex: null,
  };
  const tools = Object.assign(Object.create(HighlightTools.prototype), {
    _unifiedCandidateSet: new Set([0]),
    _unifiedStepCount: 1,
    canvas,
    cellSelectionEnabled: false,
    getRenderContext: () => focusedContext,
    getViewPositions: viewId => {
      assert.equal(viewId, 'non-focused-pane');
      return panePositions;
    },
    getSpatialQueryOwner: (viewId) => {
      assert.equal(viewId, 'non-focused-pane');
      return paneOwner;
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
  assert.notEqual(rayCalls[0][5], clickedViewMatrix);
  assert.deepEqual([...rayCalls[0][5]], [...clickedViewMatrix]);
  assert.equal(rayCalls[0][6], -0.2);

  // Mutating the producer's object cannot alter the captured interaction.
  sourceViewport.projectionMatrix[12] = 0.8;
  sourceViewport.cameraForward.set([0, 1, 0]);
  sourceViewport.cameraTargetRadius = 800;
  clickedViewMatrix[12] = 0.7;
  focusedContext.modelMatrix[12] = 0.5;

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

test('a stale lasso retires with one empty preview and no selection callback', t => {
  installBrowserPixelRatio(t);
  const positions = Float32Array.from([0, 0, 0]);
  const firstTransparency = Float32Array.of(1);
  const nextTransparency = Float32Array.of(1);
  const firstOwner = {
    viewId: 'pane',
    positions,
    publishedPositions: positions,
    transparency: firstTransparency,
    dimensionLevel: 3,
    spatialIndex: null,
  };
  const nextOwner = {
    ...firstOwner,
    transparency: nextTransparency,
  };
  const canvas = createCanvas(100, 100);
  const previewPayloads = [];
  const tools = Object.assign(Object.create(HighlightTools.prototype), {
    _transparencyGenerations: new Map(),
    _unifiedCandidateSet: new Set([7]),
    _unifiedStepCount: 2,
    _lassoPreviewPublished: true,
    altKeyDown: true,
    canvas,
    getRenderContext: () => ({
      viewMatrix: identityMatrix(),
      modelMatrix: identityMatrix(),
    }),
    getNavigationState: () => ({
      navigationMode: 'orbit',
      isDragging: false,
    }),
    getSpatialQueryOwner: viewId => {
      assert.equal(viewId, 'pane');
      return nextOwner;
    },
    highlightMode: 'none',
    highlightRenderer: {
      clearViewBuffer() {},
    },
    isLassoing: true,
    isProximityDragging: false,
    knnEnabled: false,
    lassoCtx: createDrawingContext(),
    lassoEnabled: true,
    lassoPath: [
      { x: 40, y: 40 },
      { x: 60, y: 40 },
      { x: 60, y: 60 },
    ],
    lassoPreviewCallback: payload => {
      previewPayloads.push(payload);
    },
    lassoViewContext: {
      viewId: 'pane',
      viewport: createViewport({
        viewId: 'pane',
        width: 100,
        height: 100,
        offsetX: 0,
        projectionShift: 0,
      }),
      viewMatrix: identityMatrix(),
      modelMatrix: identityMatrix(),
      spatialOwner: firstOwner,
    },
    mat4: createExactMat4(),
    proximityEnabled: false,
  });

  assert.equal(
    tools.handleMouseMove({ clientX: 70, clientY: 70 }),
    true,
  );
  assert.equal(tools.isLassoing, false);
  assert.equal(tools.lassoViewContext, null);
  assert.equal(previewPayloads.length, 1);
  assert.deepEqual(previewPayloads[0].cellIndices, []);
  assert.equal(previewPayloads[0].cellCount, 0);
  assert.equal(previewPayloads[0].type, 'lasso-preview');
  assert.deepEqual([...tools.lassoCandidateSet], [7]);
  assert.equal(tools.lassoStepCount, 2);
});

test('snapshot proximity remains bound to its pane and retires only with that view', t => {
  installBrowserPixelRatio(t);
  const positions = Float32Array.from([0, 0, 0]);
  const transparency = Float32Array.of(1);
  const snapshotOwner = {
    viewId: 'snapshot',
    positions,
    publishedPositions: positions,
    transparency,
    dimensionLevel: 3,
    spatialIndex: null,
  };
  const viewport = createViewport({
    viewId: 'snapshot',
    width: 100,
    height: 100,
    offsetX: 100,
    projectionShift: 0,
    cameraTargetRadius: 5,
  });
  let previewPayload = null;
  const tools = Object.assign(Object.create(HighlightTools.prototype), {
    _transparencyGenerations: new Map(),
    _unifiedCandidateSet: null,
    _unifiedStepCount: 0,
    altKeyDown: true,
    canvas: createCanvas(200, 100),
    getRenderContext: () => ({
      viewMatrix: identityMatrix(),
      modelMatrix: identityMatrix(),
    }),
    getNavigationState: () => ({
      navigationMode: 'orbit',
      isDragging: false,
    }),
    getSpatialQueryOwner: viewId => {
      assert.equal(viewId, 'snapshot');
      return snapshotOwner;
    },
    highlightMode: 'none',
    highlightRenderer: {
      clearViewBuffer() {},
    },
    isLassoing: false,
    isProximityDragging: true,
    knnEnabled: false,
    lassoCtx: createDrawingContext(),
    lassoEnabled: false,
    mat4: createExactMat4(),
    proximityCenter: {
      screenX: 150,
      screenY: 50,
      worldPos: [0, 0, 0],
      cellIndex: 0,
      mode: 'intersect',
      viewport,
      viewId: 'snapshot',
      viewMatrix: identityMatrix(),
      modelMatrix: identityMatrix(),
      spatialOwner: snapshotOwner,
    },
    proximityCurrentRadius: 0,
    proximityEnabled: true,
    proximityPreviewCallback: payload => {
      previewPayload = payload;
    },
  });

  // An unrelated live-view retirement must not touch the snapshot gesture.
  assert.equal(tools.retireSpatialInteractions('live'), false);
  assert.equal(tools.isProximityDragging, true);
  assert.equal(
    tools.handleMouseMove({ clientX: 170, clientY: 50 }),
    true,
  );
  assert.deepEqual(previewPayload.cellIndices, [0]);

  tools.clearViewState('snapshot');
  assert.equal(tools.isProximityDragging, false);
  assert.equal(tools.proximityCenter, null);
  assert.equal(tools.proximityCandidateSet, null);
  assert.deepEqual(previewPayload.cellIndices, []);
  assert.equal(previewPayload.cellCount, 0);
  assert.equal(previewPayload.newCellCount, 0);
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

// ---------------------------------------------------------------------------
// Every Alt gesture the renderer consumes produces an observable outcome
// ---------------------------------------------------------------------------

/**
 * A renderer wired to one cell at the origin, with every gesture callback
 * recorded. `pickCell` decides what the pointer lands on.
 */
function createGestureRenderer({ pickCell, enabled = {} }) {
  const positions = Float32Array.from([0, 0, 0]);
  const transparency = Float32Array.of(1);
  const owner = {
    viewId: 'pane',
    positions,
    publishedPositions: positions,
    transparency,
    dimensionLevel: 3,
    spatialIndex: null,
  };
  const published = [];
  const record = tool => event => published.push({ tool, event });
  const canvas = createCanvas(100, 100);
  const tools = Object.assign(Object.create(HighlightTools.prototype), {
    _lassoPreviewPublished: false,
    _transparencyGenerations: new Map(),
    _unifiedCandidateSet: null,
    _unifiedStepCount: 0,
    altKeyDown: true,
    canvas,
    cellSelectionEnabled: true,
    getNavigationState: () => ({
      navigationMode: 'orbit',
      isDragging: false,
    }),
    getRenderContext: () => ({
      viewMatrix: identityMatrix(),
      modelMatrix: identityMatrix(),
    }),
    getSpatialQueryOwner: () => owner,
    getViewportInfoAtScreen: () => createViewport({
      viewId: 'pane',
      width: 100,
      height: 100,
      offsetX: 0,
      projectionShift: 0,
    }),
    getViewTransparency: () => transparency,
    highlightMode: 'categorical',
    isKnnDragging: false,
    isLassoing: false,
    isProximityDragging: false,
    knnCandidateSet: null,
    knnEnabled: false,
    knnStepCallback: record('knn'),
    knnStepCount: 0,
    lassoCandidateSet: null,
    lassoCtx: createDrawingContext(),
    lassoEnabled: false,
    lassoMode: 'intersect',
    lassoPath: [],
    lassoPreviewCallback: null,
    lassoStepCallback: record('lasso'),
    lassoStepCount: 0,
    lassoViewContext: null,
    mat4: createExactMat4(),
    pickCellAtScreen: () => pickCell,
    proximityCandidateSet: null,
    proximityEnabled: false,
    proximityStepCallback: record('proximity'),
    selectionDragStart: null,
    selectionStepCallback: record('annotation'),
    ...enabled,
  });
  return { canvas, owner, published, tools };
}

function altMouseDown() {
  let prevented = false;
  return {
    event: {
      altKey: true,
      button: 0,
      clientX: 50,
      clientY: 50,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault() {
        prevented = true;
      },
    },
    wasPrevented: () => prevented,
  };
}

test(
  'an Alt+click that lands on no cell reports the miss instead of returning '
  + 'without a word',
  t => {
    installBrowserPixelRatio(t);
    const owner = createGestureRenderer({ pickCell: -1 });
    const down = altMouseDown();

    const handled = owner.tools.handleMouseDown(down.event);

    assert.equal(handled, false, 'a miss still leaves the drag to the camera');
    assert.equal(down.wasPrevented(), true);
    assert.equal(owner.tools.selectionDragStart, null);
    assert.deepEqual(owner.published, [{
      tool: 'annotation',
      event: {
        abandoned: 'no-cell-under-pointer',
        step: 0,
        candidateCount: 0,
      },
    }]);
  }
);

for (const [mode, flag] of [['knn', 'knnEnabled'], ['proximity', 'proximityEnabled']]) {
  test(
    `a missed Alt+click in ${mode} mode is reported by ${mode} alone`,
    t => {
      installBrowserPixelRatio(t);
      const owner = createGestureRenderer({
        pickCell: -1,
        enabled: { [flag]: true },
      });

      owner.tools.handleMouseDown(altMouseDown().event);

      assert.deepEqual(
        owner.published.map(entry => entry.tool),
        [mode],
        'the tool that owns the mode owns the panel, so only it may speak'
      );
      assert.equal(
        owner.published[0].event.abandoned,
        'no-cell-under-pointer'
      );
    }
  );
}

/** Arm a lasso whose polygon is `path`, ready for release. */
function armLasso(owner, path) {
  owner.tools.isLassoing = true;
  owner.tools.lassoEnabled = true;
  owner.tools.lassoPath = path;
  owner.tools.lassoViewContext = {
    viewId: 'pane',
    viewport: createViewport({
      viewId: 'pane',
      width: 100,
      height: 100,
      offsetX: 0,
      projectionShift: 0,
    }),
    viewMatrix: identityMatrix(),
    modelMatrix: identityMatrix(),
    spatialOwner: owner.owner,
  };
}

test('a lasso that encloses no cells still publishes its step', t => {
  installBrowserPixelRatio(t);
  const owner = createGestureRenderer({ pickCell: -1 });
  // The one cell projects to the canvas centre; this polygon is nowhere near it.
  armLasso(owner, [
    { x: 5, y: 5 },
    { x: 15, y: 5 },
    { x: 15, y: 15 },
    { x: 5, y: 15 },
  ]);

  assert.equal(
    owner.tools.handleMouseUp({ target: owner.canvas }),
    true
  );

  assert.deepEqual(owner.published, [{
    tool: 'lasso',
    event: {
      step: 1,
      candidateCount: 0,
      candidates: [],
      mode: 'intersect',
    },
  }]);
  assert.equal(owner.tools.lassoStepCount, 1);
});

test(
  'a drag released off the render canvas is retired rather than committed',
  t => {
    installBrowserPixelRatio(t);
    const owner = createGestureRenderer({ pickCell: -1 });
    // This polygon does enclose the cell, so a commit here would be visible.
    armLasso(owner, [
      { x: 40, y: 40 },
      { x: 60, y: 40 },
      { x: 60, y: 60 },
      { x: 40, y: 60 },
    ]);

    assert.equal(
      owner.tools.handleMouseUp({ target: { tagName: 'BUTTON' } }),
      true
    );

    assert.deepEqual(owner.published, [{
      tool: 'lasso',
      event: {
        abandoned: 'released-off-view',
        step: 0,
        candidateCount: 0,
      },
    }]);
    assert.equal(owner.tools.isLassoing, false);
    assert.equal(owner.tools.lassoViewContext, null);
    assert.equal(
      owner.tools.lassoCandidateSet,
      null,
      'nothing may be committed by a release the view never received'
    );
    assert.equal(owner.tools.lassoStepCount, 0);
  }
);

test('a release inside the render canvas still commits', t => {
  installBrowserPixelRatio(t);
  const owner = createGestureRenderer({ pickCell: -1 });
  armLasso(owner, [
    { x: 40, y: 40 },
    { x: 60, y: 40 },
    { x: 60, y: 60 },
    { x: 40, y: 60 },
  ]);

  owner.tools.handleMouseUp({ target: owner.canvas });

  assert.deepEqual(owner.published, [{
    tool: 'lasso',
    event: {
      step: 1,
      candidateCount: 1,
      candidates: [0],
      mode: 'intersect',
    },
  }]);
});
