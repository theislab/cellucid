import assert from 'node:assert/strict';
import test from 'node:test';

import {
  drawKnnIndicator,
  drawProximityIndicator,
  HighlightTools,
} from '../assets/js/rendering/highlight-renderer.js';
import { LassoHitTest } from '../assets/js/rendering/selection-gesture-queries.js';
import { SELECT_MODE_OFF } from '../assets/js/rendering/select-mode.js';

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
      contains(name) {
        return classes.has(name);
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
    clips: [],
    beginPath() {},
    clearRect() {},
    clip() {},
    rect(x, y, width, height) {
      this.clips.push({ x, y, width, height });
    },
    restore() {},
    save() {},
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
  visibleOffsetX = offsetX,
  visibleWidth = width,
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
    visibleOffsetX,
    visibleOffsetY: offsetY,
    visibleWidth,
    visibleHeight: height,
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
        dimensionLevel: 3,
      });
      assertClose(knnContext.arcs.at(-1).x, overlayCase.expectedCanvasX);
      assert.equal(knnContext.arcs.at(-1).y, 50);

      const mvpMatrix = mat4.create();
      mat4.multiply(mvpMatrix, viewport.projectionMatrix, identityMatrix());
      mat4.multiply(mvpMatrix, mvpMatrix, modelMatrix);
      const lasso = new LassoHitTest({
        positions: Float32Array.from([0, 0, 0]),
        dimensionLevel: 3,
        transparency: Uint8Array.from([1]),
        mvpMatrix,
        viewport,
      });
      lasso.prepare(Infinity);
      for (const [x, y] of [[-3, 47], [3, 47], [3, 53], [-3, 53]]) {
        lasso.appendVertex(overlayCase.expectedCanvasX + x, y);
      }
      const selected = lasso.hits().toArray();
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
  const paneTransparency = Uint8Array.of(1);
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
    altKeyDown: true,
    selectMode: SELECT_MODE_OFF,
    canvas,
    cellSelectionEnabled: false,
    getRenderContext: () => focusedContext,
    getSpatialQueryOwner: (viewId) => {
      assert.equal(viewId, 'non-focused-pane');
      return paneOwner;
    },
    getViewportInfoAtScreen: () => sourceViewport,
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
  const handled = tools.handlePointerDown({
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
    tools.handlePointerMove({
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
  const firstTransparency = Uint8Array.of(1);
  const nextTransparency = Uint8Array.of(1);
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
    selectMode: SELECT_MODE_OFF,
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
    tools.handlePointerMove({ clientX: 70, clientY: 70 }),
    true,
  );
  assert.equal(tools.isLassoing, false);
  assert.equal(tools.lassoViewContext, null);
  assert.equal(previewPayloads.length, 1);
  assert.deepEqual(previewPayloads[0].cellIndices, new Uint32Array(0));
  assert.equal(previewPayloads[0].cellCount, 0);
  assert.equal(previewPayloads[0].type, 'lasso-preview');
  assert.deepEqual([...tools.lassoCandidateSet], [7]);
  assert.equal(tools.lassoStepCount, 2);
});

test('snapshot proximity remains bound to its pane and retires only with that view', t => {
  installBrowserPixelRatio(t);
  const positions = Float32Array.from([0, 0, 0]);
  const transparency = Uint8Array.of(1);
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
    selectMode: SELECT_MODE_OFF,
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
    tools.handlePointerMove({ clientX: 170, clientY: 50 }),
    true,
  );
  assert.deepEqual(previewPayload.cellIndices, Uint32Array.of(0));

  tools.clearViewState('snapshot');
  assert.equal(tools.isProximityDragging, false);
  assert.equal(tools.proximityCenter, null);
  assert.equal(tools.proximityCandidateSet, null);
  assert.deepEqual(previewPayload.cellIndices, new Uint32Array(0));
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
  const transparency = Uint8Array.of(1);
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
    selectMode: SELECT_MODE_OFF,
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
    getViewFieldKind: () => 'categorical',
    getViewIdAtCanvasPoint: () => 'pane',
    _pointerClientX: Number.NaN,
    _pointerClientY: Number.NaN,
    _canvasOriginX: 0,
    _canvasOriginY: 0,
    _pointerPaneFieldKind: null,
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

    const handled = owner.tools.handlePointerDown(down.event);

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

      owner.tools.handlePointerDown(altMouseDown().event);

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
    owner.tools.handlePointerUp(owner.canvas),
    true
  );

  assert.deepEqual(owner.published, [{
    tool: 'lasso',
    event: {
      step: 1,
      candidateCount: 0,
      candidates: new Uint32Array(0),
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
      owner.tools.handlePointerUp({ tagName: 'BUTTON' }),
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

  owner.tools.handlePointerUp(owner.canvas);

  assert.deepEqual(owner.published, [{
    tool: 'lasso',
    event: {
      step: 1,
      candidateCount: 1,
      candidates: Uint32Array.of(0),
      mode: 'intersect',
    },
  }]);
});

// ---------------------------------------------------------------------------
// Select mode feeds the same press pipeline a held Alt does
// ---------------------------------------------------------------------------

function plainPress(modifiers = {}) {
  return {
    altKey: false,
    button: 0,
    clientX: 50,
    clientY: 50,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() {},
    ...modifiers,
  };
}

test('with select mode on, a press with no Alt runs the active tool', t => {
  installBrowserPixelRatio(t);
  const owner = createGestureRenderer({
    pickCell: 0,
    enabled: { altKeyDown: false },
  });
  owner.tools.setSelectMode({ enabled: true, combine: 'intersect' });

  assert.equal(owner.tools.handlePointerDown(plainPress()), true);
  assert.equal(owner.tools.selectionDragStart.cellIndex, 0);
  assert.equal(owner.tools.selectionDragStart.viewId, 'pane');
  assert.equal(owner.tools.handlePointerUp(owner.canvas), true);

  assert.deepEqual(owner.published.map(entry => entry.tool), ['annotation']);
  assert.equal(owner.published[0].event.type, 'click');
  assert.equal(owner.published[0].event.mode, 'intersect');
  assert.equal(owner.published[0].event.viewId, 'pane');
});

test('with select mode off, a press with no Alt is left to the camera', t => {
  installBrowserPixelRatio(t);
  const owner = createGestureRenderer({
    pickCell: 0,
    enabled: { altKeyDown: false, lassoEnabled: true },
  });

  assert.equal(owner.tools.handlePointerDown(plainPress()), false);
  assert.equal(owner.tools.selectionDragStart, null);
  assert.equal(owner.tools.isLassoing, false);
  assert.deepEqual(owner.published, []);
});

test('select mode combine stands in for Shift and Ctrl; a held key still wins', t => {
  installBrowserPixelRatio(t);
  const cases = [
    [{ enabled: true, combine: 'union' }, {}, 'union'],
    [{ enabled: true, combine: 'subtract' }, {}, 'subtract'],
    [{ enabled: true, combine: 'union' }, { ctrlKey: true }, 'subtract'],
    [{ enabled: true, combine: 'subtract' }, { shiftKey: true }, 'union'],
    // Off, combine is never read: Alt alone intersects as it always has.
    [{ enabled: false, combine: 'union' }, { altKey: true }, 'intersect'],
  ];
  for (const [selectMode, modifiers, expected] of cases) {
    const owner = createGestureRenderer({
      pickCell: 0,
      enabled: { altKeyDown: false, lassoEnabled: true },
    });
    owner.tools.setSelectMode(selectMode);
    assert.equal(owner.tools.handlePointerDown(plainPress(modifiers)), true);
    assert.equal(
      owner.tools.lassoMode,
      expected,
      `${JSON.stringify(selectMode)} + ${JSON.stringify(modifiers)}`
    );
  }
});

test('a lasso interrupted before release is abandoned, never committed', t => {
  installBrowserPixelRatio(t);
  const owner = createGestureRenderer({ pickCell: -1 });
  armLasso(owner, [
    { x: 40, y: 40 },
    { x: 60, y: 40 },
    { x: 60, y: 60 },
    { x: 40, y: 60 },
  ]);

  assert.equal(owner.tools.interruptPointerGesture(), true);
  assert.deepEqual(owner.published, [{
    tool: 'lasso',
    event: { abandoned: 'interrupted', step: 0, candidateCount: 0 },
  }]);
  assert.equal(owner.tools.isLassoing, false);
  assert.equal(owner.tools.lassoCandidateSet, null);
  assert.equal(owner.tools.lassoStepCount, 0);
  assert.equal(
    owner.tools.interruptPointerGesture(),
    false,
    'with nothing in flight there is nothing to interrupt'
  );
});

test('select mode shows the active tool cursor the way a held Alt does', t => {
  installBrowserPixelRatio(t);
  const owner = createGestureRenderer({
    pickCell: -1,
    enabled: { altKeyDown: false, lassoEnabled: true },
  });
  owner.tools.updateSelectionCursor();
  assert.equal(owner.canvas.style.cursor, 'grab');
  owner.tools.setSelectMode({ enabled: true, combine: 'intersect' });
  assert.equal(owner.canvas.style.cursor, 'crosshair');
  owner.tools.setSelectMode({ enabled: false, combine: 'intersect' });
  assert.equal(owner.canvas.style.cursor, 'grab');
});

// ---------------------------------------------------------------------------
// An annotation press is gated, and its cursor drawn, by the pane under it
// ---------------------------------------------------------------------------

/** A grid of three panes side by side, 30 px each; past x = 90 is no pane. */
const PANE_KINDS = Object.freeze({
  continuousPane: 'continuous',
  categoricalPane: 'categorical',
  fieldlessPane: 'none',
});

function paneAtX(x) {
  if (x < 30) return 'continuousPane';
  if (x < 60) return 'categoricalPane';
  if (x < 90) return 'fieldlessPane';
  return null;
}

for (const [viewId, kind, cursor, canvasClass] of [
  ['categoricalPane', 'categorical', 'cell', 'selecting'],
  ['continuousPane', 'continuous', 'ns-resize', 'selecting-continuous'],
]) {
  test(
    `an Alt press in a ${kind} pane starts there although the focused view `
    + 'has no field',
    t => {
      installBrowserPixelRatio(t);
      const owner = createGestureRenderer({
        pickCell: 0,
        enabled: {
          // The focused view is colored by no field; only the pressed pane is.
          getViewFieldKind: id => (id === viewId ? kind : 'none'),
          getViewportInfoAtScreen: () => createViewport({
            viewId,
            width: 100,
            height: 100,
            offsetX: 0,
            projectionShift: 0,
          }),
        },
      });
      const down = altMouseDown();

      assert.equal(owner.tools.handlePointerDown(down.event), true);
      assert.equal(down.wasPrevented(), true);
      assert.equal(owner.tools.selectionDragStart.viewId, viewId);
      assert.equal(owner.canvas.style.cursor, cursor);
      assert.equal(owner.canvas.classList.contains(canvasClass), true);
      assert.deepEqual(owner.published, []);
    }
  );
}

test(
  'an Alt press in a pane colored by no field is consumed and reported, '
  + 'whatever the focused view shows',
  t => {
    installBrowserPixelRatio(t);
    let picks = 0;
    const owner = createGestureRenderer({
      pickCell: 0,
      enabled: {
        // Every other view has a field; the pressed one has none.
        getViewFieldKind: id => (id === 'pane' ? 'none' : 'categorical'),
        pickCellAtScreen: () => {
          picks += 1;
          return 0;
        },
      },
    });
    const down = altMouseDown();

    assert.equal(
      owner.tools.handlePointerDown(down.event),
      true,
      'the press is the selection tool\'s, so it neither rotates the camera '
      + 'nor moves focus'
    );
    assert.equal(down.wasPrevented(), true);
    assert.equal(owner.tools.selectionDragStart, null);
    assert.equal(picks, 0, 'a pane with no field has nothing to pick for');
    assert.deepEqual(owner.published, [{
      tool: 'annotation',
      event: { abandoned: 'no-field-in-pane', step: 0, candidateCount: 0 },
    }]);
  }
);

test('a pane field kind outside the renderer vocabulary is refused', t => {
  installBrowserPixelRatio(t);
  const owner = createGestureRenderer({
    pickCell: 0,
    enabled: { getViewFieldKind: () => 'category' },
  });
  assert.throws(
    () => owner.tools.handlePointerDown(altMouseDown().event),
    /Field kind of view "pane" must be exactly "none", "continuous", or "categorical"/
  );
  assert.throws(
    () => owner.tools.setViewFieldKindSource('categorical'),
    /View field kind source must be one function/
  );
});

test('the armed annotation cursor follows the pane under the pointer', t => {
  installBrowserPixelRatio(t);
  const lookups = [];
  const owner = createGestureRenderer({
    pickCell: -1,
    enabled: {
      altKeyDown: false,
      getViewFieldKind: viewId => PANE_KINDS[viewId],
      getViewIdAtCanvasPoint: (x, y) => {
        lookups.push([x, y]);
        return paneAtX(x);
      },
    },
  });
  const cursorWrites = [];
  let cursor = 'grab';
  Object.defineProperty(owner.canvas.style, 'cursor', {
    get: () => cursor,
    set: value => {
      cursor = value;
      cursorWrites.push(value);
    },
  });
  const move = clientX => {
    assert.equal(
      owner.tools.handlePointerMove({ clientX, clientY: 50 }),
      false,
      'an idle move belongs to the camera'
    );
  };

  // Unarmed, a move costs no pane lookup and draws nothing.
  move(10);
  assert.deepEqual(lookups, []);
  assert.deepEqual(cursorWrites, []);

  owner.tools.handleAltKeyDown();
  assert.equal(cursor, 'ns-resize');
  move(20);
  move(25);
  assert.deepEqual(
    cursorWrites,
    ['ns-resize'],
    'moving within one pane redraws nothing'
  );
  move(40);
  assert.equal(cursor, 'cell');
  move(70);
  assert.equal(cursor, 'not-allowed');
  move(95);
  assert.equal(cursor, 'grab', 'off every pane a press would not select');
  assert.deepEqual(
    cursorWrites,
    ['ns-resize', 'cell', 'not-allowed', 'grab']
  );

  owner.tools.handleAltKeyUp();
  move(10);
  assert.equal(cursor, 'grab');
  const lookupsWhileUnarmed = lookups.length;
  move(40);
  assert.equal(lookups.length, lookupsWhileUnarmed);
});
