import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  HighlightTools,
} from '../assets/js/rendering/highlight-renderer.js';

function createKnnTools() {
  const removedClasses = [];
  const canvas = {
    classList: {
      remove(...names) {
        removedClasses.push(...names);
      },
    },
    getBoundingClientRect() {
      return { width: 640, height: 480 };
    },
    style: {
      cursor: 'ns-resize',
    },
  };
  const lassoCtx = {
    clearRect() {},
    scale() {},
    setTransform() {},
  };
  const tools = Object.create(HighlightTools.prototype);
  Object.assign(tools, {
    canvas,
    isKnnDragging: false,
    knnAdjacencyList: null,
    knnCandidateSet: null,
    knnCurrentDegree: 0,
    knnEdgesLoaded: false,
    knnSeedCell: null,
    knnStepCount: 0,
    lassoCtx,
  });
  tools.updateCursorForHighlightMode = () => {
    canvas.style.cursor = 'default';
  };
  return { canvas, removedClasses, tools };
}

test('KNN edge ownership accepts only exact normalized arrays including empty graphs', () => {
  const { tools } = createKnnTools();

  assert.throws(
    () => tools.loadKnnEdges([0], [1]),
    /Uint32Array/
  );
  assert.throws(
    () => tools.loadKnnEdges(
      Uint32Array.from([0, 1]),
      Uint32Array.from([1])
    ),
    /equal length/
  );

  assert.equal(
    tools.loadKnnEdges(new Uint32Array(0), new Uint32Array(0)),
    true
  );
  assert.equal(tools.isKnnEdgesLoaded(), true);
  assert.deepEqual(tools.knnAdjacencyList, new Map());
});

test('dataset replacement clears every KNN graph and interaction owner', t => {
  const previousWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  t.after(() => {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  });

  const { canvas, removedClasses, tools } = createKnnTools();
  tools.loadKnnEdges(
    Uint32Array.from([0, 1]),
    Uint32Array.from([1, 2])
  );
  tools.isKnnDragging = true;
  tools.knnSeedCell = { cellIndex: 1 };
  tools.knnCurrentDegree = 2;
  tools.knnCandidateSet = new Set([0, 1, 2]);
  tools.knnStepCount = 3;

  tools.clearKnnEdges();

  assert.equal(tools.isKnnEdgesLoaded(), false);
  assert.equal(tools.knnAdjacencyList, null);
  assert.equal(tools.isKnnDragging, false);
  assert.equal(tools.knnSeedCell, null);
  assert.equal(tools.knnCurrentDegree, 0);
  assert.equal(tools.knnCandidateSet, null);
  assert.equal(tools.knnStepCount, 0);
  assert.equal(canvas.style.cursor, 'default');
  assert.ok(removedClasses.includes('knn-dragging'));
});

test('viewer edge teardown releases every dataset-owned GPU edge state', async () => {
  const source = await readFile(
    new URL('../assets/js/rendering/viewer.js', import.meta.url),
    'utf8'
  );
  const clearStart = source.indexOf('function detachEdgeResourcesV2()');
  const nextFunction = source.indexOf(
    'function createPositionTextureV2ForView',
    clearStart
  );
  assert.ok(clearStart >= 0 && nextFunction > clearStart);
  const clearSource = source.slice(clearStart, nextFunction);
  assert.match(
    clearSource,
    /if \(edgeTextureV2 !== null\) retiringTextures\.add\(edgeTextureV2\)/
  );
  assert.match(
    clearSource,
    /retiringTextures\.add\(edgeWeightTextureV2\)/
  );
  assert.match(clearSource, /edgePositionTexturePoolV2\.clear\(\)/);
  assert.match(clearSource, /edgePositionTexturesV2\.clear\(\)/);
  assert.match(clearSource, /edgeVisibilityTexturesV2\.clear\(\)/);
  assert.match(clearSource, /nEdgesV2 = 0/);
  assert.match(clearSource, /nCellsV2 = 0/);
  assert.match(clearSource, /hasEdgeDataV2 = false/);
  assert.match(clearSource, /useInstancedEdges = false/);
  assert.match(clearSource, /edgeSourcesV2 = null/);
  assert.match(clearSource, /edgeDestinationsV2 = null/);
  assert.match(clearSource, /edgePrefixOwnersV2\.clear\(\)/);
  assert.match(clearSource, /edgePrefixCheckpointStaging = null/);
  assert.match(clearSource, /edgeAllVisiblePrefixOwner = null/);
  assert.match(clearSource, /edgeVisibleTarget = 0/);
  assert.match(
    clearSource,
    /for \(const texture of retiringTextures\) \{\s*queueEdgeTextureRetirement\(texture\)/
  );
  assert.match(
    clearSource,
    /failures\.push\(\.\.\.drainEdgeTextureRetirements\(\)\)/
  );
  assert.match(
    clearSource,
    /throw new AggregateError\(\s*failures,\s*'Connectivity resources were detached with pending texture retirement failures\.'/
  );
  const detachIndex = clearSource.indexOf('edgeTextureV2 = null;');
  const queueIndex = clearSource.indexOf(
    'queueEdgeTextureRetirement(texture);'
  );
  const drainIndex = clearSource.indexOf('drainEdgeTextureRetirements()');
  assert.ok(detachIndex >= 0 && detachIndex < queueIndex);
  assert.ok(queueIndex < drainIndex);

  const queueStart = source.indexOf(
    'function queueEdgeTextureRetirement(texture)'
  );
  const retirementEnd = source.indexOf(
    'function reportCommittedRetirementFailures',
    queueStart
  );
  assert.ok(queueStart >= 0 && retirementEnd > queueStart);
  const retirementSource = source.slice(queueStart, retirementEnd);
  assert.match(
    retirementSource,
    /pendingEdgeTextureRetirements\.add\(texture\)/
  );
  assert.match(
    retirementSource,
    /return drainExactTextureRetirements\(\s*gl,\s*pendingEdgeTextureRetirements/
  );
  const exactRetirementStart = source.indexOf(
    'export function drainExactTextureRetirements'
  );
  const exactRetirementEnd = source.indexOf(
    'function assertNonEmptyTrimmedString',
    exactRetirementStart
  );
  const exactRetirementSource = source.slice(
    exactRetirementStart,
    exactRetirementEnd
  );
  assert.match(
    exactRetirementSource,
    /for \(const texture of Array\.from\(pending\)\)/
  );
  assert.match(
    exactRetirementSource,
    /gl\.deleteTexture\(texture\);\s*pending\.delete\(texture\)/
  );
  assert.match(
    exactRetirementSource,
    /definitelyRetired = gl\.isTexture\(texture\) === false/
  );
  assert.match(
    exactRetirementSource,
    /if \(definitelyRetired\) \{\s*pending\.delete\(texture\)/
  );
  assert.match(
    exactRetirementSource,
    /else \{\s*failures\.push\(exactError\)/
  );
  assert.match(
    source,
    /clearEdgesV2\(\) \{\s*clearEdgeResourcesV2\(\);\s*\}/
  );
  assert.match(
    source,
    /hpRenderer\.loadData\([\s\S]+?reportCommittedRetirementFailures\(\s*detachEdgeResourcesV2\(\),\s*'Connectivity resources from the prior committed dataset generation could not be fully retired\.'\s*\)/
  );

  const setupStart = source.indexOf(
    'setupEdgesV2(edgeData, positions = null)'
  );
  assert.ok(setupStart >= 0);
  const updateStart = source.indexOf(
    'updateEdgeVisibilityV2(visibility)',
    setupStart
  );
  const setupSource = source.slice(setupStart, updateStart);
  assert.doesNotMatch(setupSource, /nEdges === 0/);
  assert.match(setupSource, /weights instanceof Float64Array/);
  assert.match(setupSource, /createEdgeTexturesV2\(/);
  assert.match(setupSource, /hasEdgeDataV2 = true/);
  assert.match(
    source,
    /hasConnectivityData\(\) \{ return hasEdgeDataV2; \}/
  );
  assert.doesNotMatch(
    source,
    /enableEdgesV2\(\)[\s\S]{0,300}nEdgesV2 > 0/
  );
  assert.match(
    source,
    /return updateVisibilityTextureV2ForView\(\s*LIVE_VIEW_ID,\s*visibility\s*\)/
  );
  assert.doesNotMatch(
    source,
    /updateEdgeVisibilityV2ForView[\s\S]{0,500}Update live view's visibility/
  );

  const textureLookupStart = source.indexOf(
    'function getEdgeTexturesForView(viewId)'
  );
  const textureLookupEnd = source.indexOf(
    'function hasEdgeTexturesForView',
    textureLookupStart
  );
  assert.ok(
    textureLookupStart >= 0 && textureLookupEnd > textureLookupStart
  );
  const textureLookupSource = source.slice(
    textureLookupStart,
    textureLookupEnd
  );
  assert.doesNotMatch(textureLookupSource, /String\(viewId\)/);
  assert.doesNotMatch(textureLookupSource, /fallback|legacy/i);
  assert.doesNotMatch(
    textureLookupSource,
    /edgeVisibilityTexturesV2\.get\(vid\)\s*\|\|/
  );
  assert.match(
    textureLookupSource,
    /edgePositionTexturesV2\.get\(vid\)/
  );
  assert.match(
    textureLookupSource,
    /edgeVisibilityTexturesV2\.get\(vid\)/
  );
  assert.doesNotMatch(
    textureLookupSource,
    /sharesLiveTransparency/
  );

  const perViewSetupStart = source.indexOf('setupEdgesV2ForView(');
  const perViewUpdateStart = source.indexOf(
    'updateEdgeVisibilityV2ForView(viewId, visibility)',
    perViewSetupStart
  );
  const perViewSetupSource = source.slice(
    perViewSetupStart,
    perViewUpdateStart
  );
  assert.match(
    perViewSetupSource,
    /if \(!createPositionTextureV2ForView[\s\S]+return false;/
  );
  assert.doesNotMatch(
    perViewSetupSource,
    /if \(!createPositionTextureV2ForView[\s\S]{0,160}deleteEdgeTexturesForView/
  );
});
