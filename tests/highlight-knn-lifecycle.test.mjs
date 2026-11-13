import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HighlightTools,
} from '../assets/js/rendering/highlight-renderer.js';
import { KnnExpansion } from '../assets/js/rendering/selection-gesture-queries.js';

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
 * A k-NN row source (`KnnRowSource`) over undirected `pairs` of
 * `cellCount` cells, answering each read as the reader worker does (a row's
 * neighbors, in request order), after a macrotask; `reads` records each
 * read's cells, `fail` makes the next read fail.
 */
function rowSourceOf(pairs, cellCount) {
  const rows = Array.from({ length: cellCount }, () => []);
  for (const [a, b] of pairs) {
    rows[a].push(b);
    rows[b].push(a);
  }
  const source = {
    nCells: cellCount,
    reads: [],
    fail: null,
    readRows(cells, { signal }) {
      source.reads.push(Array.from(cells));
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (signal.aborted) return reject(new DOMException('stopped', 'AbortError'));
          if (source.fail !== null) {
            const failure = source.fail;
            source.fail = null;
            return reject(failure);
          }
          const offsets = new Uint32Array(cells.length + 1);
          cells.forEach((cell, i) => { offsets[i + 1] = offsets[i] + rows[cell].length; });
          const neighbors = new Uint32Array(offsets[cells.length]);
          cells.forEach((cell, i) => neighbors.set(rows[cell], offsets[i]));
          resolve({ offsets, neighbors });
        }, 0);
      });
    },
  };
  return source;
}

/** The cells within `degree` hops of `seed` through drawn cells, by plain breadth-first search. */
function reference(pairs, cellCount, seed, degree, transparency) {
  const rows = Array.from({ length: cellCount }, () => []);
  for (const [a, b] of pairs) {
    rows[a].push(b);
    rows[b].push(a);
  }
  if (transparency[seed] !== 1) return [];
  const seen = new Set([seed]);
  let frontier = [seed];
  for (let d = 0; d < degree && frontier.length > 0; d++) {
    const next = [];
    for (const cell of frontier) for (const other of rows[cell]) {
      if (transparency[other] === 1 && !seen.has(other)) {
        seen.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }
  return [...seen].sort((a, b) => a - b);
}

test('KNN graph ownership takes a row source as it is', () => {
  const { tools } = createKnnTools();

  assert.throws(
    () => tools.loadKnnEdges({ sources: Uint32Array.of(0), destinations: Uint32Array.of(1) }, 2),
    /reader of its rows/
  );
  assert.throws(
    () => tools.loadKnnEdges(rowSourceOf([[0, 1]], 3), 4),
    /covers 3 cells; the views hold 4/
  );

  const empty = rowSourceOf([], 4);
  assert.equal(tools.loadKnnEdges(empty, 4), true);
  assert.equal(tools.isKnnEdgesLoaded(), true);
  // Used as delivered: nothing is read until a gesture expands.
  assert.equal(tools.knnGraph, empty);
  assert.equal(empty.reads.length, 0);
});

test('the KNN expansion reaches every neighbour of every cell, both directions, reading rows by cell', async () => {
  // Edges 0-1, 0-3, 1-2, 2-3, 4-5.
  const pairs = [[0, 1], [0, 3], [1, 2], [2, 3], [4, 5]];
  const graph = rowSourceOf(pairs, 6);
  const transparency = new Uint8Array(6).fill(1);
  const expansion = new KnnExpansion({ graph, seed: 1, transparency });
  const at = async degree => {
    await expansion.completeTo(degree);
    assert.equal(expansion.expandTo(degree, Infinity), true);
    return expansion.cells().toArray();
  };
  assert.deepEqual(await at(0), [1]);
  assert.equal(graph.reads.length, 0, 'degree 0 reads nothing');
  assert.equal(expansion.expandTo(1, Infinity), false, 'a row being read: not yet');
  assert.ok(expansion.waiting instanceof Promise);
  assert.deepEqual(await at(1), [0, 1, 2]);
  assert.deepEqual(graph.reads, [[1]], 'only the frontier\'s rows are read');
  assert.deepEqual(await at(2), [0, 1, 2, 3]);
  assert.deepEqual(await at(9), [0, 1, 2, 3]);
  // Back to a smaller degree clears only what lies beyond it.
  assert.deepEqual(await at(1), [0, 1, 2]);
  assert.deepEqual(await at(0), [1]);
  assert.deepEqual(await at(2), [0, 1, 2, 3]);
});

test('the KNN expansion walks only drawn cells and stops on a hidden seed', async () => {
  // A path 0-1-2-3: hiding 1 cuts 0 off from 2 and 3.
  const pairs = [[0, 1], [1, 2], [2, 3]];
  const transparency = Uint8Array.of(1, 0, 1, 1);
  const fromZero = new KnnExpansion({ graph: rowSourceOf(pairs, 4), seed: 0, transparency });
  await fromZero.completeTo(5);
  assert.deepEqual(fromZero.cells().toArray(), [0]);
  const hidden = rowSourceOf(pairs, 4);
  const fromHidden = new KnnExpansion({ graph: hidden, seed: 1, transparency });
  assert.equal(fromHidden.expandTo(5, Infinity), true);
  assert.deepEqual(fromHidden.cells().toArray(), []);
  assert.equal(hidden.reads.length, 0);
});

test('an expansion stopped by its deadline or its reads resumes to the same cells as breadth-first search', async () => {
  // A hub joined to 150,000 cells, each joined to the next: degree 1 is a
  // frontier of several read batches, walked past many deadline checks.
  const cellCount = 150_001;
  const pairs = [];
  for (let cell = 1; cell < cellCount; cell++) pairs.push([0, cell]);
  for (let cell = 1; cell + 1 < cellCount; cell += 2) pairs.push([cell, cell + 1]);
  const transparency = new Uint8Array(cellCount).fill(1);
  for (let cell = 0; cell < cellCount; cell += 7) transparency[cell] = cell === 0 ? 1 : 0;
  for (const degree of [1, 2, 3]) {
    const graph = rowSourceOf(pairs, cellCount);
    const sliced = new KnnExpansion({ graph, seed: 3, transparency });
    let slices = 1;
    while (!sliced.expandTo(degree, 0)) {
      slices++;
      if (sliced.waiting !== null) await sliced.waiting;
    }
    assert.ok(slices >= degree + 1, 'reads and a past deadline stop the expansion part way');
    assert.deepEqual(sliced.cells().toArray(), reference(pairs, cellCount, 3, degree, transparency), `degree ${degree}`);
    if (degree === 3) assert.ok(graph.reads.some(cells => cells.length === 1 << 16), 'a large frontier is read in batches');
  }
});

test('a failed row read ends the expansion with its error; a dropped one is stopped and forgotten', async () => {
  const pairs = [[0, 1], [1, 2]];
  const graph = rowSourceOf(pairs, 3);
  const transparency = new Uint8Array(3).fill(1);
  const failing = new KnnExpansion({ graph, seed: 0, transparency });
  graph.fail = new Error('the file is gone');
  assert.equal(failing.expandTo(2, Infinity), false);
  await failing.waiting.catch(() => {});
  assert.throws(() => failing.expandTo(2, Infinity), /the file is gone/);
  await assert.rejects(failing.completeTo(2), /the file is gone/);

  const dropped = new KnnExpansion({ graph, seed: 0, transparency });
  assert.equal(dropped.expandTo(2, Infinity), false);
  const waiting = dropped.waiting;
  dropped.dispose();
  await assert.rejects(waiting, { name: 'AbortError' });
  // Going back to degree 0 drops the read; nothing is reported.
  const back = new KnnExpansion({ graph, seed: 0, transparency });
  assert.equal(back.expandTo(1, Infinity), false);
  assert.equal(back.expandTo(0, Infinity), true);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(back.cells().toArray(), [0]);
  await back.completeTo(2);
  assert.deepEqual(back.cells().toArray(), [0, 1, 2]);
});

test('a released k-NN step is committed once its rows have arrived, after every step released before it', async () => {
  const { tools } = createKnnTools();
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 4]];
  const graph = rowSourceOf(pairs, 5);
  tools.loadKnnEdges(graph, 5);
  const steps = [];
  tools.knnStepCallback = step => steps.push({ ...step, candidates: Array.from(step.candidates) });
  const transparency = new Uint8Array(5).fill(1);
  const first = new KnnExpansion({ graph, seed: 0, transparency });
  const second = new KnnExpansion({ graph, seed: 4, transparency });
  tools._commitKnnStep(first, { graph, mode: 'union', seedCellIndex: 0, degree: 2 });
  // Its expansion is complete already: committed at once, yet after the first.
  await second.completeTo(1);
  tools._commitKnnStep(second, { graph, mode: 'union', seedCellIndex: 4, degree: 1 });
  assert.equal(steps.length, 0, 'the first step is still reading its rows');
  await tools._knnCommits;
  assert.deepEqual(steps.map(step => [step.step, step.seedCellIndex, step.candidates]), [
    [1, 0, [0, 1, 2]],
    [2, 4, [0, 1, 2, 3, 4]],
  ]);
  // Confirming waits for a step still reading its rows; canceling drops it.
  const confirmed = [];
  tools.knnCallback = event => confirmed.push(Array.from(event.cellIndices));
  const pending = new KnnExpansion({ graph, seed: 2, transparency });
  tools.knnCandidateSet = null;
  tools.knnStepCount = 0;
  tools._commitKnnStep(pending, { graph, mode: 'union', seedCellIndex: 2, degree: 1 });
  tools.confirmKnnSelection();
  assert.equal(confirmed.length, 0, 'not before the step lands');
  await tools._knnCommits;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(confirmed, [[1, 2, 3]]);
  const dropped = new KnnExpansion({ graph, seed: 0, transparency });
  const before = steps.length;
  tools._commitKnnStep(dropped, { graph, mode: 'union', seedCellIndex: 0, degree: 1 });
  tools.cancelKnnSelection();
  await tools._knnCommits;
  assert.equal(steps.length, before + 1, 'only the cancel itself is reported');
  assert.equal(steps.at(-1).cancelled, true);
  // A step whose graph was replaced while it read is dropped.
  const third = new KnnExpansion({ graph, seed: 2, transparency });
  const count = steps.length;
  tools._commitKnnStep(third, { graph, mode: 'union', seedCellIndex: 2, degree: 1 });
  tools.knnGraph = rowSourceOf(pairs, 5);
  await tools._knnCommits;
  assert.equal(steps.length, count);
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
  tools.loadKnnEdges(rowSourceOf([[0, 1], [1, 2]], 3), 3);
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
