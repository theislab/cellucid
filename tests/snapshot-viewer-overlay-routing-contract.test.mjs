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

function createRenderer({
  liveActive = true,
  liveTexture = { owner: 'live' },
  liveWidth = 17,
  viewActive = true,
  viewTexture = { owner: 'snapshot' },
  viewWidth = 19,
} = {}) {
  return {
    getAlphaTexture: () => liveTexture,
    getAlphaTextureWidth: () => liveWidth,
    isAlphaTextureActive: () => liveActive,
    getAlphaTextureForView: () => viewTexture,
    getAlphaTextureWidthForView: () => viewWidth,
    isAlphaTextureActiveForView: () => viewActive,
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
    /else if\s*\(\s*colorsChanged\s*\)\s*\{[\s\S]*?updateSnapshotColors\(\s*exactId,\s*colors\s*\)/,
  );
  assert.match(
    source,
    /else\s*\{[\s\S]*?updateSnapshotAlphas\(\s*exactId,\s*transparency\s*\)/,
  );
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

test('live overlay context exposes the active live alpha owner even without a snapshot override flag', () => {
  const liveTexture = { owner: 'live' };
  const ctx = buildOverlayContext(createContextOptions({
    hpRenderer: createRenderer({
      liveTexture,
      liveWidth: 23,
    }),
    isSnapshot: false,
    viewId: 'live',
  }));

  assert.strictEqual(ctx.alphaTexture, liveTexture);
  assert.equal(ctx.alphaTexWidth, 23);
  assert.equal(ctx.useAlphaTexture, true);
});

test('snapshot overlay context exposes its exact immutable R8 owner', () => {
  const liveTexture = { owner: 'live' };
  const snapshotTexture = { owner: 'snapshot-a' };
  const ctx = buildOverlayContext(createContextOptions({
    hpRenderer: createRenderer({
      liveTexture,
      liveWidth: 17,
      viewTexture: snapshotTexture,
      viewWidth: 29,
    }),
    isSnapshot: true,
    viewId: 'snapshot-a',
  }));

  assert.strictEqual(ctx.alphaTexture, snapshotTexture);
  assert.notStrictEqual(ctx.alphaTexture, liveTexture);
  assert.equal(ctx.alphaTexWidth, 29);
  assert.equal(ctx.useAlphaTexture, true);
});

test('snapshot explicit live-alpha override is reflected in its overlay context', () => {
  const liveTexture = { owner: 'live' };
  const snapshotTexture = { owner: 'snapshot-a' };
  const ctx = buildOverlayContext(createContextOptions({
    hpRenderer: createRenderer({
      liveTexture,
      liveWidth: 31,
      viewTexture: snapshotTexture,
      viewWidth: 37,
    }),
    isSnapshot: true,
    renderParams: createRenderParams(true),
    viewId: 'snapshot-a',
  }));

  assert.strictEqual(ctx.alphaTexture, liveTexture);
  assert.notStrictEqual(ctx.alphaTexture, snapshotTexture);
  assert.equal(ctx.alphaTexWidth, 31);
  assert.equal(ctx.useAlphaTexture, true);
});

test('snapshot overlay context fails closed when its selected alpha owner is unavailable', () => {
  assert.throws(
    () => buildOverlayContext(createContextOptions({
      hpRenderer: createRenderer({
        viewActive: false,
        viewTexture: null,
        viewWidth: 0,
      }),
      isSnapshot: true,
      viewId: 'snapshot-a',
    })),
    /requires the published alpha texture/,
  );
});

test('live overlay context accurately reports an inactive live alpha owner', () => {
  const ctx = buildOverlayContext(createContextOptions({
    hpRenderer: createRenderer({
      liveActive: false,
      liveTexture: null,
      liveWidth: 0,
    }),
    isSnapshot: false,
    viewId: 'live',
  }));

  assert.equal(ctx.alphaTexture, null);
  assert.equal(ctx.alphaTexWidth, 0);
  assert.equal(ctx.useAlphaTexture, false);
});
