import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertFigureExportPayload,
} from '../assets/js/app/ui/modules/figure-export/figure-export-contract.js';
import {
  createFigureExportEngine,
  reportFigureExportFailure,
} from '../assets/js/app/ui/modules/figure-export/figure-export-engine.js';
import {
  renderFigureToSvgBlob,
} from '../assets/js/app/ui/modules/figure-export/renderers/svg-renderer.js';

const IDENTITY = Float32Array.from([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function cameraState() {
  return {
    navigationMode: 'orbit',
    orbit: {
      radius: 3,
      targetRadius: 3,
      theta: 0,
      phi: Math.PI / 2,
      target: [0, 0, 0],
    },
    freefly: {
      position: [0, 0, 3],
      yaw: 0,
      pitch: 0,
    },
  };
}

function renderState() {
  return {
    antialias: true,
    bgColor: Float32Array.from([1, 1, 1]),
    cameraDistance: 3,
    cameraPosition: [0, 0, 3],
    far: 100,
    fogColor: Float32Array.from([1, 1, 1]),
    fogDensity: 0,
    fogFar: 3.5,
    fogNear: 2.5,
    fov: Math.PI / 4,
    lightDir: Float32Array.from([0, 0, 1]),
    lightingStrength: 1,
    modelMatrix: new Float32Array(IDENTITY),
    mvpMatrix: new Float32Array(IDENTITY),
    near: 0.01,
    pointSize: 4,
    projectionMatrix: new Float32Array(IDENTITY),
    shaderQuality: 'full',
    sizeAttenuation: 1,
    viewMatrix: new Float32Array(IDENTITY),
    viewportHeight: 100,
    viewportWidth: 100,
  };
}

function payload({
  positions = Float32Array.from([0, 0, 0]),
  transparency = Float32Array.from([1]),
} = {}) {
  const pointCount = positions.length / 3;
  const colors = new Uint8Array(pointCount * 4);
  colors.fill(255);
  return {
    dpi: null,
    format: 'svg',
    height: 100,
    meta: {
      views: [{
        fieldKey: null,
        fieldKind: null,
        filters: [],
        id: 'live',
        label: 'Live',
      }],
    },
    options: {
      axisLabelFontSizePx: 12,
      background: 'viewer',
      backgroundColor: '#ffffff',
      centroidLabelFontSizePx: 12,
      crop: null,
      depthSort3d: false,
      emphasizeSelection: false,
      fontFamily: 'Arial, sans-serif',
      fontSizePx: 12,
      height: 100,
      includeAxes: true,
      includeLegend: false,
      legendFontSizePx: 12,
      legendPosition: 'right',
      optimizedTargetCount: null,
      referenceGrid: null,
      selectionMutedOpacity: 0.15,
      showOrientation: true,
      strategy: 'full-vector',
      tickFontSizePx: 12,
      title: '',
      titleFontSizePx: 15,
      width: 100,
      xLabel: 'X',
      yLabel: 'Y',
    },
    selection: {
      highlightArray: null,
      totalCount: 0,
      visibleCount: 0,
    },
    title: '',
    views: [{
      cameraState: cameraState(),
      data: {
        centroidColors: null,
        centroidFlags: { labels: false, points: false },
        centroidLabelTexts: [],
        centroidPositions: null,
        colors,
        pointCount,
        positions,
        transparency,
      },
      id: 'live',
      label: 'Live',
      renderState: renderState(),
      scientificState: {
        datasetGeneration: 7,
        dimensionLevel: 3,
        fieldKey: null,
        fieldKind: null,
        filters: [],
        geometryGeneration: 11,
        legendModel: null,
        lodMembership: null,
        lodSizeMultiplier: 1,
        normTransform: {
          center: [0, 0, 0],
          scale: 1,
        },
      },
    }],
    width: 100,
  };
}

test('figure-export payload owns every asynchronous renderer input', () => {
  const exact = payload();
  assert.equal(assertFigureExportPayload(exact), exact);

  const missingScientificState = structuredClone(exact);
  delete missingScientificState.views[0].scientificState;
  assert.throws(
    () => assertFigureExportPayload(missingScientificState),
    /scientificState/
  );

  const missingFog = payload();
  delete missingFog.views[0].renderState.fogNear;
  assert.throws(
    () => assertFigureExportPayload(missingFog),
    /fogNear/
  );

  const wrongHighlightOwner = payload();
  wrongHighlightOwner.selection = {
    highlightArray: new Uint8Array(2),
    totalCount: 1,
    visibleCount: 1,
  };
  assert.throws(
    () => assertFigureExportPayload(wrongHighlightOwner),
    /highlightArray/
  );
});

test('all-filtered SVG export is deterministic and does not fail axes', async () => {
  const exact = payload({ transparency: Float32Array.from([0]) });
  const blob = await renderFigureToSvgBlob({
    payload: exact,
    signal: new AbortController().signal,
  });
  assert.equal(blob.type, 'image/svg+xml');
  const svg = await blob.text();
  assert.match(svg, /No visible cells/);
  assert.doesNotMatch(svg, /<circle /);
});

function exactPngRequest(signal) {
  return {
    axisLabelFontSizePx: 12,
    background: 'viewer',
    backgroundColor: '#ffffff',
    centroidLabelFontSizePx: 12,
    crop: null,
    depthSort3d: false,
    dpi: 300,
    emphasizeSelection: false,
    exportAllViews: false,
    fontFamily: 'Arial, sans-serif',
    fontSizePx: 12,
    format: 'png',
    height: 100,
    includeAxes: true,
    includeLegend: false,
    legendFontSizePx: 12,
    legendPosition: 'right',
    optimizedTargetCount: null,
    referenceGrid: null,
    selectionMutedOpacity: 0.15,
    showOrientation: true,
    signal,
    strategy: null,
    tickFontSizePx: 12,
    title: '',
    titleFontSizePx: 15,
    width: 100,
    xLabel: 'X',
    yLabel: 'Y',
  };
}

test('pre-aborted export rejects before snapshotting any live owner', async () => {
  let stateReads = 0;
  let viewerReads = 0;
  const state = new Proxy({}, {
    get() {
      stateReads += 1;
      throw new Error('state must not be read after pre-abort');
    },
  });
  const viewer = new Proxy({}, {
    get() {
      viewerReads += 1;
      throw new Error('viewer must not be read after pre-abort');
    },
  });
  const engine = createFigureExportEngine({ state, viewer });
  const controller = new AbortController();
  const reason = new DOMException('fixture teardown', 'AbortError');
  controller.abort(reason);

  await assert.rejects(
    engine.exportFigure(exactPngRequest(controller.signal)),
    (error) => error === reason
  );
  assert.equal(stateReads, 0);
  assert.equal(viewerReads, 0);
});

test('reentrant abort in one grid snapshot fences every later borrowed owner', async () => {
  const controller = new AbortController();
  const reason = new DOMException('reentrant fixture teardown', 'AbortError');
  const positions = Float32Array.from([0, 0, 0]);
  const colors = Uint8Array.from([255, 255, 255, 255]);
  const transparency = Float32Array.from([1]);
  const presented = {
    cameraState: cameraState(),
    dimensionLevel: 3,
    geometryGeneration: 11,
    lodMembership: null,
    lodSizeMultiplier: 1,
    renderState: renderState(),
  };
  const emptyViewContext = () => ({
    centroidColors: null,
    centroidLabels: [],
    centroidPositions: null,
  });
  const state = {
    centroidColors: null,
    centroidLabels: [],
    centroidPositions: null,
    dimensionManager: {
      getNormTransform() {
        return { center: [0, 0, 0], scale: 1 };
      },
    },
    getActiveViewId() {
      return 'live';
    },
    getDatasetGeneration() {
      return 7;
    },
    getFieldForView() {
      return null;
    },
    getFilterSummaryForView() {
      return [];
    },
    getHighlightedCellCount() {
      return 0;
    },
    getLegendModel() {
      return null;
    },
    getTotalHighlightedCellCount() {
      return 0;
    },
    getViewDimensionLevel() {
      return 3;
    },
    pointCount: 1,
    viewContexts: new Map([
      ['snapshot-1', emptyViewContext()],
      ['snapshot-2', emptyViewContext()],
    ]),
  };
  const borrowedCalls = [];
  const viewer = {
    getCentroidFlags() {
      return { labels: false, points: false };
    },
    getAntialiasing() {
      return true;
    },
    getLiveViewLabel() {
      return 'Live';
    },
    getPointCount() {
      return 1;
    },
    getPresentedViewState() {
      return presented;
    },
    getSnapshotViews() {
      return [
        { id: 'snapshot-1', label: 'Snapshot 1' },
        { id: 'snapshot-2', label: 'Snapshot 2' },
      ];
    },
    getViewLayout() {
      return { liveViewHidden: false, mode: 'grid' };
    },
    withBorrowedViewData(viewId, callback) {
      borrowedCalls.push(viewId);
      if (viewId === 'live') controller.abort(reason);
      return callback({
        colors,
        dimensionLevel: 3,
        geometryGeneration: 11,
        lodMembership: null,
        pointCount: 1,
        positions,
        transparency,
      });
    },
  };

  const engine = createFigureExportEngine({ state, viewer });
  await assert.rejects(
    engine.exportFigure({
      ...exactPngRequest(controller.signal),
      exportAllViews: true,
    }),
    (error) => error === reason
  );
  assert.deepEqual(borrowedCalls, ['live']);
});

test('figure-export failures publish one exact visible terminal outcome', () => {
  const calls = [];
  const notifications = {
    failCalculation(id, message) {
      calls.push(['fail', id, message]);
    },
    error(message, options) {
      calls.push(['error', message, options]);
    },
  };
  const failure = new Error('snapshot rejected');
  const originalConsoleError = console.error;
  const consoleCalls = [];
  console.error = (...args) => {
    consoleCalls.push(args);
  };
  try {
    assert.equal(
      reportFigureExportFailure(failure, {
        notifications,
        calculationId: 'figure-owner',
      }),
      failure
    );
    assert.equal(
      reportFigureExportFailure(failure, {
        notifications: {
          failCalculation() {
            throw new Error('duplicate failure notification');
          },
          error() {
            throw new Error('duplicate error notification');
          },
        },
        calculationId: 'different-owner',
      }),
      failure
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(calls, [
    ['fail', 'figure-owner', 'snapshot rejected'],
    [
      'error',
      'Export failed: snapshot rejected',
      { category: 'render', duration: 6000 },
    ],
  ]);
  assert.equal(consoleCalls.length, 1);
  assert.equal(consoleCalls[0][0], '[FigureExport] Export failed:');
  assert.equal(consoleCalls[0][1], failure);
});

test('engine snapshots before its first await and renderers consume payload only', async () => {
  const root = new URL(
    '../assets/js/app/ui/modules/figure-export/',
    import.meta.url
  );
  const [engine, svg, png, rasterizer] = await Promise.all([
    readFile(new URL('figure-export-engine.js', root), 'utf8'),
    readFile(new URL('renderers/svg-renderer.js', root), 'utf8'),
    readFile(new URL('renderers/png-renderer.js', root), 'utf8'),
    readFile(new URL('utils/webgl-point-rasterizer.js', root), 'utf8'),
  ]);

  assert.match(engine, /withBorrowedViewData\(vid,/);
  assert.match(engine, /cloneTypedOwner\(\s*borrowed\.positions,/);
  assert.match(engine, /cloneTypedOwner\(\s*borrowed\.colors,/);
  assert.match(engine, /cloneTypedOwner\(\s*borrowed\.transparency,/);
  assert.doesNotMatch(
    engine,
    /new Uint8Array\(exact\.admissionLevels\)/,
    'atomic LOD snapshots must own K admitted IDs without duplicating dense N admission bytes'
  );
  assert.match(engine, /renderFigureToSvgBlob\(\{\s*payload,\s*signal\s*\}\)/);
  assert.match(engine, /renderFigureToPngBlob\(\{\s*payload,\s*signal\s*\}\)/);
  assert.match(
    engine,
    /assertFigureExportSingleRequest\(options\)[\s\S]*catch \(error\) \{[\s\S]*reportFigureExportFailure\(error\)/
  );
  assert.match(
    engine,
    /assertFigureExportBatchRequest\(options\)[\s\S]*catch \(error\) \{[\s\S]*reportFigureExportFailure\(error\)/
  );
  assert.doesNotMatch(engine, /getViewRenderState|getViewCameraState/);
  assert.ok(
    engine.indexOf('const payloadBase = {') <
      engine.indexOf("import('./renderers/"),
    'the complete owned payload must precede every asynchronous boundary'
  );

  for (const [name, renderer] of [['SVG', svg], ['PNG', png]]) {
    assert.match(
      renderer,
      /renderFigureTo(?:Svg|Png)Blob\(\{\s*payload,\s*signal\s*=\s*null\s*\}\)/
    );
    assert.doesNotMatch(
      renderer,
      /\b(?:state|viewer)\s*\.(?:get|dimensionManager|highlightArray)/,
      `${name} renderer must not read live state after export starts`
    );
  }
  assert.doesNotMatch(rasterizer, /boundsToSphere|packed\.bounds/);
  assert.match(rasterizer, /const fogNear = renderState\.fogNear/);
  assert.match(rasterizer, /const fogFar = renderState\.fogFar/);
});
