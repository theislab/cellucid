import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  HighlightTools,
} from '../assets/js/rendering/highlight-renderer.js';
import { KnnExpansion } from '../assets/js/rendering/selection-gesture-queries.js';
import { extractConnectivityEdges } from '../assets/js/data/connectivity-edges.js';

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
    knnGraph: null,
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

/**
 * The reader's edge payload (`ConnectivityEdges`) for undirected `pairs`
 * over `cellCount` cells, from the symmetric CSR matrix they form.
 */
function graphOf(pairs, cellCount) {
  const rows = Array.from({ length: cellCount }, () => []);
  for (const [a, b] of pairs) {
    rows[a].push(b);
    rows[b].push(a);
  }
  const indptr = [0];
  const indices = [];
  for (const row of rows) {
    row.sort((left, right) => left - right);
    indices.push(...row);
    indptr.push(indices.length);
  }
  return extractConnectivityEdges({
    format: 'csr',
    shape: [cellCount, cellCount],
    indptr: Int32Array.from(indptr),
    indices: Int32Array.from(indices),
    data: new Float32Array(indices.length).fill(1),
  }, cellCount);
}

test('KNN graph ownership takes the edge payload as it is, including an empty graph', () => {
  const { tools } = createKnnTools();

  assert.throws(
    () => tools.loadKnnEdges({ sources: Uint32Array.of(0), destinations: Uint32Array.of(1) }, 2),
    /edge payload/
  );
  assert.throws(
    () => tools.loadKnnEdges(graphOf([[0, 1]], 3), 4),
    /covers 3 cells; the views hold 4/
  );

  const empty = graphOf([], 4);
  assert.equal(tools.loadKnnEdges(empty, 4), true);
  assert.equal(tools.isKnnEdgesLoaded(), true);
  // Used as delivered: no copy, no rebuild on the page.
  assert.equal(tools.knnGraph, empty);
});

test('the KNN expansion reaches every neighbour of every cell, both directions', () => {
  // Edges 0-1, 0-3, 1-2, 2-3, 4-5.
  const graph = graphOf([[0, 1], [0, 3], [1, 2], [2, 3], [4, 5]], 6);
  const transparency = new Uint8Array(6).fill(1);
  const expansion = new KnnExpansion({ graph, seed: 1, transparency });
  const at = degree => {
    assert.equal(expansion.expandTo(degree, Infinity), true);
    return expansion.cells().toArray();
  };
  assert.deepEqual(at(0), [1]);
  assert.deepEqual(at(1), [0, 1, 2]);
  assert.deepEqual(at(2), [0, 1, 2, 3]);
  assert.deepEqual(at(9), [0, 1, 2, 3]);
  // Back to a smaller degree clears only what lies beyond it.
  assert.deepEqual(at(1), [0, 1, 2]);
  assert.deepEqual(at(0), [1]);
  assert.deepEqual(at(2), [0, 1, 2, 3]);
});

test('the KNN expansion walks only drawn cells and stops on a hidden seed', () => {
  // A path 0-1-2-3: hiding 1 cuts 0 off from 2 and 3.
  const graph = graphOf([[0, 1], [1, 2], [2, 3]], 4);
  const transparency = Uint8Array.of(1, 0, 1, 1);
  const fromZero = new KnnExpansion({ graph, seed: 0, transparency });
  fromZero.expandTo(5, Infinity);
  assert.deepEqual(fromZero.cells().toArray(), [0]);
  const fromHidden = new KnnExpansion({ graph, seed: 1, transparency });
  fromHidden.expandTo(5, Infinity);
  assert.deepEqual(fromHidden.cells().toArray(), []);
});

test('an expansion stopped by its deadline resumes to the same cells', () => {
  // A ring of 50,000 cells: the frontier work passes many deadline checks.
  const cellCount = 50_000;
  const pairs = [];
  for (let cell = 0; cell < cellCount; cell++) pairs.push([cell, (cell + 1) % cellCount]);
  const graph = graphOf(pairs, cellCount);
  const transparency = new Uint8Array(cellCount).fill(1);
  const sliced = new KnnExpansion({ graph, seed: 7, transparency });
  let slices = 1;
  while (!sliced.expandTo(30_000, 0)) slices++;
  const whole = new KnnExpansion({ graph, seed: 7, transparency });
  whole.expandTo(30_000, Infinity);
  assert.ok(slices > 1, 'a past deadline stops the expansion part way');
  assert.deepEqual(sliced.cells().toArray(), whole.cells().toArray());
  assert.equal(sliced.cells().size, cellCount);
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
  tools.loadKnnEdges(graphOf([[0, 1], [1, 2]], 3), 3);
  tools.isKnnDragging = true;
  tools.knnSeedCell = { cellIndex: 1 };
  tools.knnCurrentDegree = 2;
  tools.knnCandidateSet = new Set([0, 1, 2]);
  tools.knnStepCount = 3;

  tools.clearKnnEdges();

  assert.equal(tools.isKnnEdgesLoaded(), false);
  assert.equal(tools.knnGraph, null);
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
