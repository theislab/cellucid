import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';
import {
  centroidSnapshotBufferOwnsData,
} from '../assets/js/rendering/viewer.js';

function extractSourceRange(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function identityMatrix() {
  return Float64Array.from([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
}

function bounds(overrides = {}) {
  return {
    minX: -1,
    maxX: 1,
    minY: -1,
    maxY: 1,
    minZ: -1,
    maxZ: 1,
    ...overrides,
  };
}

function frustumViewState() {
  return {
    frustumPlanes: Array.from(
      { length: 6 },
      () => new Float32Array(4),
    ),
    lastDimensionLevel: undefined,
    lastFrustumBounds: null,
    lastFrustumMVP: null,
  };
}

test('frustum preparation extracts planes only when exact matrix, dimension, or bounds change', () => {
  const renderer = Object.create(HighPerfRenderer.prototype);
  let extractions = 0;
  renderer.extractFrustumPlanes = (_mvp, planes) => {
    extractions += 1;
    return planes;
  };

  const viewState = frustumViewState();
  const matrix = identityMatrix();
  const exactBounds = bounds();

  assert.equal(
    renderer._prepareFrustumCache(
      matrix,
      viewState,
      3,
      exactBounds,
    ),
    true,
  );
  assert.equal(extractions, 1);

  assert.equal(
    renderer._prepareFrustumCache(
      matrix,
      viewState,
      3,
      exactBounds,
    ),
    false,
  );
  assert.equal(
    extractions,
    1,
    'an unchanged pane must not renormalize six frustum planes',
  );

  const changedMatrix = identityMatrix();
  changedMatrix[12] = Number.EPSILON;
  assert.equal(
    renderer._prepareFrustumCache(
      changedMatrix,
      viewState,
      3,
      exactBounds,
    ),
    true,
  );
  assert.equal(extractions, 2);

  assert.equal(
    renderer._prepareFrustumCache(
      changedMatrix,
      viewState,
      3,
      bounds({ maxX: 2 }),
    ),
    true,
  );
  assert.equal(
    extractions,
    3,
    'snapshot bounds are part of exact frustum admission',
  );
});

test('failed frustum extraction cannot publish cache keys', () => {
  const renderer = Object.create(HighPerfRenderer.prototype);
  const viewState = frustumViewState();
  const acceptedMatrix = identityMatrix();
  const acceptedBounds = bounds();
  renderer.extractFrustumPlanes = (_mvp, planes) => planes;
  renderer._prepareFrustumCache(
    acceptedMatrix,
    viewState,
    2,
    acceptedBounds,
  );

  const acceptedMatrixOwner = viewState.lastFrustumMVP;
  const acceptedBoundsOwner = viewState.lastFrustumBounds;
  const changedMatrix = identityMatrix();
  changedMatrix[0] = 2;
  renderer.extractFrustumPlanes = () => {
    throw new Error('injected extraction failure');
  };

  assert.throws(
    () => renderer._prepareFrustumCache(
      changedMatrix,
      viewState,
      3,
      bounds({ minZ: -2 }),
    ),
    /injected extraction failure/,
  );
  assert.strictEqual(viewState.lastFrustumMVP, acceptedMatrixOwner);
  assert.strictEqual(viewState.lastFrustumBounds, acceptedBoundsOwner);
  assert.equal(viewState.lastDimensionLevel, 2);
  assert.deepEqual(
    Array.from(viewState.lastFrustumMVP),
    Array.from(acceptedMatrix),
  );
});

test('snapshot LOD/frustum consumes the caller-owned cache transition', async () => {
  const source = await readFile(
    new URL(
      '../assets/js/rendering/high-perf-renderer.js',
      import.meta.url,
    ),
    'utf8',
  );
  const snapshotRender = extractSourceRange(
    source,
    'renderWithSnapshot(',
    '/**\n   * Render snapshot with frustum culling',
  );
  const snapshotLodFrustum =
    HighPerfRenderer.prototype
      ._renderSnapshotLODWithFrustumCulling
      .toString();
  const snapshotLodOnly =
    HighPerfRenderer.prototype
      ._renderSnapshotWithLOD
      .toString();

  assert.match(
    snapshotRender,
    /lodBuffersForDim,\s*frustumChanged\s*\)/,
  );
  assert.match(
    snapshotLodFrustum,
    /lodBuffersForDim,\s*frustumChanged\s*\)/,
  );
  assert.doesNotMatch(
    snapshotLodOnly.slice(
      0,
      snapshotLodOnly.indexOf(') {'),
    ),
    /frustumChanged/,
  );
});

test('viewer opts out of detached stats records and hot render branches publish scalar stats', async () => {
  const [viewerSource, rendererSource] = await Promise.all([
    readFile(
      new URL('../assets/js/rendering/viewer.js', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL(
        '../assets/js/rendering/high-perf-renderer.js',
        import.meta.url,
      ),
      'utf8',
    ),
  ]);
  const singleView = extractSourceRange(
    viewerSource,
    'function renderSingleView(',
    'function setBackground(',
  );
  const liveRender = extractSourceRange(
    rendererSource,
    'render(params',
    '_renderWithFrustumCulling(',
  );
  const snapshotRender = extractSourceRange(
    rendererSource,
    'renderWithSnapshot(',
    '/**\n   * Render snapshot with frustum culling',
  );

  assert.match(singleView, /hpRenderer\.render\(renderParams,\s*false\)/);
  assert.match(
    singleView,
    /hpRenderer\.renderWithSnapshot\(snapshotBufferId,\s*renderParams,\s*false\)/,
  );
  assert.match(liveRender, /returnStats\s*=\s*true/);
  assert.match(snapshotRender, /returnStats\s*=\s*true/);
  assert.doesNotMatch(
    liveRender,
    /return\s+this\.getStats\(viewId\)/,
    'viewer-disabled stats must not allocate a detached record',
  );
  assert.doesNotMatch(
    snapshotRender,
    /return\s+this\.getStats\(viewId\)/,
    'snapshot panes must honor the same stats opt-out',
  );
  assert.doesNotMatch(
    rendererSource,
    /this\._updateStats\(viewState,\s*\{/,
    'draw paths must publish scalar stats without temporary records',
  );
});

test('viewer steady-frame shell reuses viewport, flags, titles, axes, and scissor ownership', async () => {
  const source = await readFile(
    new URL('../assets/js/rendering/viewer.js', import.meta.url),
    'utf8',
  );
  const renderSource = extractSourceRange(
    source,
    'function render()',
    'function renderSingleView(',
  );
  const singleView = extractSourceRange(
    source,
    'function renderSingleView(',
    'function setBackground(',
  );
  const titleSource = extractSourceRange(
    source,
    'function updateViewTitles(',
    'function repositionViewTitles(',
  );
  const axesSource = extractSourceRange(
    source,
    'function getFreeflyAxes()',
    '// Extract camera position and axes',
  );

  assert.doesNotMatch(
    renderSource,
    /\{\s*x:\s*(?:0|col\s*\/\s*cols),\s*y:/,
    'viewport geometry must be passed as scalars or a stable owner',
  );
  assert.doesNotMatch(
    singleView,
    /\bgetViewFlags\(/,
    'internal point/label decisions must not allocate public flag records',
  );
  assert.doesNotMatch(
    titleSource,
    /\.map\([^)]*=>[^)]*\)\.join\(/s,
    'static grid frames must not allocate a title-key array/string',
  );
  assert.doesNotMatch(
    axesSource,
    /return\s*\{\s*forward:/,
    'free-flight axes must reuse one generation-owned record',
  );

  const gridLoop = extractSourceRange(
    renderSource,
    '// Grid mode: render multiple viewports',
    '// Aggregate label layer visibility once per frame',
  );
  assert.equal(
    (gridLoop.match(/gl\.enable\(gl\.SCISSOR_TEST\)/g) || []).length,
    1,
  );
  assert.equal(
    (gridLoop.match(/gl\.disable\(gl\.SCISSOR_TEST\)/g) || []).length,
    1,
  );
});

test('unchanged titles and centroid labels skip redundant CSSOM publication', async () => {
  const source = await readFile(
    new URL('../assets/js/rendering/viewer.js', import.meta.url),
    'utf8',
  );
  const titleVisibility = extractSourceRange(
    source,
    'function hideViewTitles()',
    'function updateViewTitleActiveState()',
  );
  const layerVisibility = extractSourceRange(
    source,
    'function updateLabelLayerVisibility()',
    '/**\n   * Update view title chips',
  );
  const labelPositions = extractSourceRange(
    source,
    'function updateCentroidLabelPositions(',
    'function render()',
  );

  assert.match(
    titleVisibility,
    /if\s*\([^)]*style\.display\s*!==/s,
  );
  assert.match(
    layerVisibility,
    /if\s*\([^)]*style\.display\s*!==/s,
  );
  assert.match(
    labelPositions,
    /centroidLabelPresentation/,
    'label visibility and coordinates need a per-element presentation cache',
  );
  assert.match(
    labelPositions,
    /previous\.(?:x|screenX)\s*!==\s*screenX/,
  );
  assert.match(
    labelPositions,
    /previous\.(?:y|screenY)\s*!==\s*screenY/,
  );
});

test('all panes share one frame phase and highlight success does not allocate failure storage', async () => {
  const [viewerSource, highlightSource] = await Promise.all([
    readFile(
      new URL('../assets/js/rendering/viewer.js', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL(
        '../assets/js/rendering/highlight-renderer.js',
        import.meta.url,
      ),
      'utf8',
    ),
  ]);
  const singleView = extractSourceRange(
    viewerSource,
    'function renderSingleView(',
    'function setBackground(',
  );
  const drawSource = extractSourceRange(
    highlightSource,
    'draw({',
    '// ============================================================================\n// 2D OVERLAY & HIGHLIGHT TOOLS',
  );

  assert.match(
    singleView,
    /highlightTools\.drawHighlights\(renderParams,\s*timeSeconds\)/,
    'the viewer-owned frame timestamp must be shared by every pane',
  );
  assert.doesNotMatch(
    drawSource,
    /performance\.now\(\)/,
    'highlight panes must not sample independent clocks',
  );
  assert.doesNotMatch(
    drawSource,
    /const\s+restorationFailures\s*=\s*\[\]/,
    'the successful highlight path must not allocate failure-only storage',
  );
});

test('multiview lookup and connectivity texture reads avoid pane-cadence callbacks and records', async () => {
  const source = await readFile(
    new URL('../assets/js/rendering/viewer.js', import.meta.url),
    'utf8',
  );
  const renderSource = extractSourceRange(
    source,
    'function render()',
    'function renderSingleView(',
  );
  const singleView = extractSourceRange(
    source,
    'function renderSingleView(',
    'function setBackground(',
  );
  const edgeLookup = extractSourceRange(
    source,
    'function getEdgeTexturesForView(',
    '/**\n   * Check if a view has per-view edge textures',
  );

  assert.doesNotMatch(renderSource, /_renderAllViews\.find\(/);
  assert.doesNotMatch(singleView, /snapshotViews\.find\(/);
  assert.match(
    source,
    /const\s+edgeTextureLookupScratch\s*=\s*\{/,
    'serial pane rendering can reuse one texture lookup record',
  );
  assert.doesNotMatch(
    edgeLookup,
    /const\s+validateAndReturn\s*=\s*\(/,
    'texture validation must not create a closure per pane',
  );
  assert.doesNotMatch(
    edgeLookup,
    /return\s*\{\s*posTexture:/,
    'texture lookup must not create a result record per pane',
  );
});

test('centroid snapshot readiness uses exact position and color owners without hot fingerprints', async () => {
  const source = await readFile(
    new URL('../assets/js/rendering/viewer.js', import.meta.url),
    'utf8',
  );
  const readinessSource = extractSourceRange(
    source,
    'function centroidBufferNeedsUpdate(',
    'function drawCentroidsWithSnapshot(',
  );
  const positions = new Float32Array(6);
  const colors = new Uint8Array(8);
  const accepted = {
    positionsOwner: positions,
    colorsOwner: colors,
    count: 2,
  };

  assert.equal(
    centroidSnapshotBufferOwnsData(
      accepted,
      positions,
      colors,
    ),
    true,
  );
  assert.equal(
    centroidSnapshotBufferOwnsData(
      accepted,
      new Float32Array(positions),
      colors,
    ),
    false,
    'equal-value position replacement is a distinct publication',
  );
  assert.equal(
    centroidSnapshotBufferOwnsData(
      accepted,
      positions,
      new Uint8Array(colors),
    ),
    false,
    'color-only replacement must invalidate the VAO certificate',
  );
  assert.doesNotMatch(
    readinessSource,
    /fingerprint|toFixed|`/,
    'unchanged snapshot panes must not sample or stringify centroids',
  );
  assert.match(
    readinessSource,
    /centroidSnapshotBufferOwnsData/,
  );
});
