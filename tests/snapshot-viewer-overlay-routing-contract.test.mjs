import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildOverlayContext,
} from '../assets/js/rendering/overlays/overlay-context.js';

const viewerSource = await readFile(
  new URL('../assets/js/rendering/viewer.js', import.meta.url),
  'utf8',
);

function snapshotUpdateSource() {
  const start = viewerSource.indexOf(
    '    updateSnapshotAttributes(id, attrs) {',
  );
  const end = viewerSource.indexOf(
    '\n    removeSnapshotView(id) {',
    start,
  );
  assert.ok(start >= 0);
  assert.ok(end > start);
  return viewerSource.slice(start, end);
}

function createRenderParams(useAlphaTexture = false) {
  const matrix = new Float32Array(16);
  return {
    mvpMatrix: matrix,
    viewMatrix: matrix,
    modelMatrix: matrix,
    projectionMatrix: matrix,
    viewportWidth: 640,
    viewportHeight: 480,
    fov: Math.PI / 4,
    sizeAttenuation: 1,
    fogDensity: 0,
    fogColor: [1, 1, 1],
    cameraPosition: [0, 0, 3],
    cameraDistance: 3,
    useAlphaTexture,
  };
}

function createRenderer() {
  return {
    getFogNear: () => 0,
    getFogFar: () => 10,
    getCurrentLODLevel: () => -1,
    getCurrentLodIndices: () => null,
  };
}

function createContextOptions({
  hpRenderer,
  isSnapshot,
  renderParams = createRenderParams(),
  viewId,
}) {
  return {
    gl: {},
    viewId,
    frameId: 7,
    renderParams,
    timeSeconds: 1,
    deltaTimeSeconds: 1 / 60,
    isSnapshot,
    dimensionLevel: 3,
    layoutKey: '3d',
    devicePixelRatio: 2,
    viewportX: 0,
    viewportY: 0,
    scissorEnabled: false,
    outputFramebuffer: null,
    hpRenderer,
    getViewPositions: () => new Float32Array(),
    getViewTransparency: () => new Float32Array(),
    target: {},
  };
}

test('snapshot attribute publication uses the narrowest renderer transaction for candidate and rollback', () => {
  const source = snapshotUpdateSource();

  assert.match(
    source,
    /if\s*\(\s*colorsChanged\s*&&\s*transparencyChanged\s*\)\s*\{[\s\S]*?updateSnapshotBuffer\(/,
  );
  assert.match(
    source,
    /if\s*\(\s*colorsChanged\s*\)\s*\{[\s\S]*?updateSnapshotColors\(\s*exactId,\s*colors\s*\)/,
  );
  // An alpha-only publication reports whether a byte moved.
  assert.match(
    source,
    /return hpRenderer\.updateSnapshotAlphas\(\s*exactId,\s*transparency\s*\)/,
  );
  assert.match(source, /if \(visibilityMoved\) \{\n\s*highlightTools\.handleTransparencyChange\(exactId\);/);
  assert.match(source, /if \(transparencyChanged\) snap\.transparency\.set\(nextTransparency\);/);
  assert.equal(
    source.match(/publishSnapshotPointAttributes\(/g)?.length,
    2,
    'the exact dispatcher must serve candidate publication and restoration',
  );
  assert.match(
    source,
    /publishSnapshotPointAttributes\(\s*nextColors,\s*nextTransparency\s*\)/,
  );
  assert.match(
    source,
    /publishSnapshotPointAttributes\(\s*snap\.colors,\s*snap\.transparency\s*\)/,
  );
});

test('the overlay context carries no point-alpha owner (overlays keep their own visibility)', () => {
  for (const [viewId, isSnapshot] of [['live', false], ['snapshot-a', true]]) {
    const ctx = buildOverlayContext(createContextOptions({
      hpRenderer: createRenderer(),
      isSnapshot,
      viewId,
    }));
    for (const key of ['alphaTexture', 'alphaTexWidth', 'useAlphaTexture']) {
      assert.equal(Object.hasOwn(ctx, key), false, `${viewId} ${key}`);
    }
  }
});
