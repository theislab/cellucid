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
  tools.updateSelectionCursor = () => {
    canvas.style.cursor = 'default';
  };
  return { canvas, removedClasses, tools };
}

test('KNN edge ownership accepts only exact normalized arrays including empty graphs', () => {
  const { tools } = createKnnTools();

  assert.throws(
    () => tools.loadKnnEdges([0], [1], 2),
    /Uint32Array/
  );
  assert.throws(
    () => tools.loadKnnEdges(
      Uint32Array.from([0, 1]),
      Uint32Array.from([1]),
      3
    ),
    /equal length/
  );
  // Edges must follow the connectivity contract: ordered by source, then
  // source < destination < cellCount.
  assert.throws(
    () => tools.loadKnnEdges(Uint32Array.from([1, 0]), Uint32Array.from([2, 1]), 3),
    /ordered by source/
  );

  assert.equal(
    tools.loadKnnEdges(new Uint32Array(0), new Uint32Array(0), 4),
    true
  );
  assert.equal(tools.isKnnEdgesLoaded(), true);
  assert.deepEqual(Array.from(tools.knnAdjacencyList.forwardOffsets), [0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(tools.knnAdjacencyList.reverseOffsets), [0, 0, 0, 0, 0]);
});

test('the KNN adjacency lists every neighbour of every cell, both directions, without a Map', () => {
  const { tools } = createKnnTools();
  // Edges 0-1, 0-3, 1-2, 2-3 (ordered by source).
  tools.loadKnnEdges(Uint32Array.from([0, 0, 1, 2]), Uint32Array.from([1, 3, 2, 3]), 4);
  const adjacency = tools.knnAdjacencyList;
  assert.ok(!(adjacency instanceof Map));
  const neighbours = cell => {
    const out = [];
    for (let j = adjacency.forwardOffsets[cell]; j < adjacency.forwardOffsets[cell + 1]; j++) out.push(adjacency.destinations[j]);
    for (let j = adjacency.reverseOffsets[cell]; j < adjacency.reverseOffsets[cell + 1]; j++) out.push(adjacency.reverseSources[j]);
    return out.sort();
  };
  assert.deepEqual(neighbours(0), [1, 3]);
  assert.deepEqual(neighbours(1), [0, 2]);
  assert.deepEqual(neighbours(2), [1, 3]);
  assert.deepEqual(neighbours(3), [0, 2]);
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
    Uint32Array.from([1, 2]),
    3
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

test('viewer connectivity lifecycle routes through the edge layer', async () => {
  const source = await readFile(
    new URL('../assets/js/rendering/viewer.js', import.meta.url),
    'utf8'
  );
  // A new dataset drops the graph and every pane's records at once.
  assert.match(
    source,
    /hpRenderer\.loadData\([\s\S]+?edgeLayer\.clear\(\);\s*useInstancedEdges = false;/
  );
  assert.match(source, /clearEdgesV2\(\) \{\s*edgeLayer\.clear\(\);\s*useInstancedEdges = false;\s*\}/);
  // Context loss forgets handles; disposal deletes them.
  assert.match(source, /edgeLayer\.abandon\(\);/);
  assert.match(source, /edgeLayer\.dispose\(\);/);
  // Removing a kept view removes its edge records.
  assert.match(source, /edgeLayer\.deleteView\(exactId\)/);
  // No per-edge or per-cell texture is left in the viewer.
  assert.doesNotMatch(
    source,
    /edgeTextureV2|edgePositionTexture|edgeVisibilityTexture|EdgePrefix|nEdgesV2|hasEdgeDataV2/
  );
});
