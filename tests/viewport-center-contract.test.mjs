import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  applyHorizontalProjectionCenter,
  computeLeftOcclusionRatio,
  computePaneCenterNdcX,
} from '../assets/js/rendering/viewport-center.js';

const VIEWER_URL = new URL(
  '../assets/js/rendering/viewer.js',
  import.meta.url,
);
const VIEWPORT_CENTER_URL = new URL(
  '../assets/js/rendering/viewport-center.js',
  import.meta.url,
);

test('sidebar geometry publishes one device-independent canvas occlusion ratio', () => {
  assert.equal(
    computeLeftOcclusionRatio({
      canvasLeft: 0,
      canvasWidth: 1440,
      sidebarLeft: 10,
      sidebarWidth: 280,
      sidebarVisible: true,
    }),
    290 / 1440,
  );
  assert.equal(
    computeLeftOcclusionRatio({
      canvasLeft: 0,
      canvasWidth: 1440,
      sidebarLeft: 10,
      sidebarWidth: 280,
      sidebarVisible: false,
    }),
    0,
  );
  for (const sidebarWidth of [280, 420, 560]) {
    const ratio = computeLeftOcclusionRatio({
      canvasLeft: 0,
      canvasWidth: 1440,
      sidebarLeft: 10,
      sidebarWidth,
      sidebarVisible: true,
    });
    const projectedTargetX = ((ratio + 1) * 1440) / 2;
    assert.equal(projectedTargetX, (10 + sidebarWidth + 1440) / 2);
  }

  const cssRatio = computeLeftOcclusionRatio({
    canvasLeft: 24,
    canvasWidth: 1440,
    sidebarLeft: 34,
    sidebarWidth: 420,
    sidebarVisible: true,
  });
  const backingPixelRatio = computeLeftOcclusionRatio({
    canvasLeft: 48,
    canvasWidth: 2880,
    sidebarLeft: 68,
    sidebarWidth: 840,
    sidebarVisible: true,
  });
  assert.equal(cssRatio, backingPixelRatio);
});

test('target center follows the visible part of each pane', () => {
  const leftOcclusionRatio = 290 / 1440;
  assert.equal(
    computePaneCenterNdcX(0, 1, leftOcclusionRatio),
    leftOcclusionRatio,
  );
  assert.equal(
    computePaneCenterNdcX(0, 0.5, leftOcclusionRatio),
    leftOcclusionRatio / 0.5,
  );
  assert.equal(
    computePaneCenterNdcX(0.5, 0.5, leftOcclusionRatio),
    0,
  );
  assert.equal(
    computePaneCenterNdcX(0, 0.125, leftOcclusionRatio),
    null,
  );
});

test('render-loop pane centering consumes exact scalars without an options allocation', async () => {
  assert.equal(computePaneCenterNdcX(0, 1, 0.25), 0.25);
  assert.equal(computePaneCenterNdcX(0.5, 0.5, 0.25), 0);
  assert.equal(computePaneCenterNdcX(0, 0.125, 0.25), null);

  const source = await readFile(VIEWER_URL, 'utf8');
  const geometrySource = await readFile(VIEWPORT_CENTER_URL, 'utf8');
  assert.doesNotMatch(source, /computePaneCenterNdcX\(\s*\{/);
  assert.match(
    geometrySource,
    /function assertRatio\(value, label, allowOne = true\)/,
  );
  assert.doesNotMatch(geometrySource, /\{\s*allowOne\s*:/);
});

test('projection offset places the camera target at the visible center', () => {
  const matrix = new Float32Array(16);
  matrix[0] = 2;
  matrix[5] = 2;
  matrix[10] = -1;
  matrix[11] = -1;
  const centerNdcX = 290 / 1440;

  assert.equal(applyHorizontalProjectionCenter(matrix, centerNdcX), matrix);
  assert.ok(Math.abs(matrix[8] + centerNdcX) < 1e-7);

  const viewSpaceTargetZ = -3;
  const clipX = matrix[8] * viewSpaceTargetZ;
  const clipW = -viewSpaceTargetZ;
  assert.ok(Math.abs((clipX / clipW) - centerNdcX) < 1e-7);
});

test('viewport centering rejects ambiguous or invalid geometry', () => {
  const validGeometry = {
    canvasLeft: 0,
    canvasWidth: 1440,
    sidebarLeft: 10,
    sidebarWidth: 280,
    sidebarVisible: true,
  };
  for (const invalid of [undefined, null, '1440', Number.NaN, Infinity, -Infinity]) {
    assert.throws(
      () => computeLeftOcclusionRatio({ ...validGeometry, canvasWidth: invalid }),
      /finite number|object/i,
    );
  }
  assert.throws(
    () => computeLeftOcclusionRatio({ ...validGeometry, sidebarVisible: 1 }),
    /boolean/i,
  );
  assert.throws(
    () => computePaneCenterNdcX(0.75, 0.5, 0),
    /canvas bounds/i,
  );
  assert.throws(
    () => applyHorizontalProjectionCenter(new Float32Array(15), 0),
    /16-element/i,
  );
  assert.throws(
    () => applyHorizontalProjectionCenter(new Float32Array(16), 1),
    /less than 1/i,
  );
});

test('grid projection caching is bounded to the current render geometry', async () => {
  const source = await readFile(VIEWER_URL, 'utf8');
  assert.match(source, /let cachedGridProjectionAspect = null/);
  assert.match(
    source,
    /if \(cachedGridProjectionAspect !== aspect\) \{[\s\S]*?cachedGridProjections\.clear\(\);[\s\S]*?cachedGridProjectionAspect = aspect;/,
  );
  assert.doesNotMatch(source, /`\$\{aspect\}:/);
  assert.doesNotMatch(source, /cached = \{ matrix, centerNdcX \}/);
});
