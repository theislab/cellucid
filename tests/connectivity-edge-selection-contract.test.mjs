/**
 * A pane shows the first K of its visible connectivity edges in one fixed,
 * stateless random order (connectivity-edge-selection.js).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONNECTIVITY_EDGE_ORDER_SEED,
  countVisibleConnectivityEdges,
  createConnectivityEdgeOrder,
  isEveryConnectivityCellVisible,
  selectVisibleConnectivityEdges,
} from '../assets/js/rendering/connectivity-edge-selection.js';

test('the order is a bijection of [0, E) at every size, including non-powers of four', () => {
  for (const edgeCount of [0, 1, 2, 3, 4, 5, 15, 16, 17, 1000, 4096, 65_535, 65_537, 300_001]) {
    const order = createConnectivityEdgeOrder(edgeCount);
    const seen = new Uint8Array(edgeCount);
    for (let index = 0; index < edgeCount; index++) {
      const edge = order.at(index);
      assert.ok(Number.isInteger(edge) && edge >= 0 && edge < edgeCount, `${edgeCount}: ${edge}`);
      assert.equal(seen[edge], 0, `${edgeCount}: ${edge} twice`);
      seen[edge] = 1;
    }
  }
});

test('the order is fixed by its key, differs between keys, and needs no memory per edge', () => {
  const a = createConnectivityEdgeOrder(10_000);
  const b = createConnectivityEdgeOrder(10_000);
  const c = createConnectivityEdgeOrder(10_000, CONNECTIVITY_EDGE_ORDER_SEED + 1);
  const prefix = order => Array.from({ length: 64 }, (_value, index) => order.at(index));
  assert.deepEqual(prefix(a), prefix(b));
  assert.notDeepEqual(prefix(a), prefix(c));
  // Indices far beyond 2^24 map exactly (no float rounding of ids).
  const big = createConnectivityEdgeOrder(4_000_000_000);
  const seen = new Set();
  for (const index of [0, 1, 16_777_216, 16_777_217, 2 ** 31, 3_999_999_999]) {
    const edge = big.at(index);
    assert.ok(Number.isInteger(edge) && edge >= 0 && edge < 4_000_000_000);
    assert.ok(!seen.has(edge));
    seen.add(edge);
  }
});

test('a prefix of the order is a uniform sample: every decile of edges is drawn about equally', () => {
  const edgeCount = 1_000_000;
  const order = createConnectivityEdgeOrder(edgeCount);
  const buckets = new Uint32Array(10);
  const sample = 100_000;
  for (let index = 0; index < sample; index++) buckets[Math.floor(order.at(index) / (edgeCount / 10))]++;
  for (const count of buckets) assert.ok(Math.abs(count - sample / 10) < 600, `bucket ${count}`);
});

function randomGraph(cellCount, edgeCount, seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const sources = new Uint32Array(edgeCount);
  const destinations = new Uint32Array(edgeCount);
  for (let edge = 0; edge < edgeCount; edge++) {
    const a = next() % cellCount;
    let b = next() % cellCount;
    if (b === a) b = (a + 1) % cellCount;
    sources[edge] = Math.min(a, b);
    destinations[edge] = Math.max(a, b);
  }
  return { sources, destinations };
}

test('selection takes exactly the first K visible edges of the order, and the count is every visible edge', () => {
  const cellCount = 2000;
  const edgeCount = 30_000;
  const { sources, destinations } = randomGraph(cellCount, edgeCount, 7);
  const order = createConnectivityEdgeOrder(edgeCount);
  let state = 99;
  const transparency = Uint8Array.from({ length: cellCount }, () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state % 10 < 6 ? 1 : 0;
  });
  const admissionLevels = Uint8Array.from({ length: cellCount }, (_value, cell) => cell % 5);
  for (const visibility of [
    { transparency, admissionLevels: null, lodLevel: -1 },
    { transparency, admissionLevels, lodLevel: 2 },
  ]) {
    const visible = edge => (
      transparency[sources[edge]] === 1 && transparency[destinations[edge]] === 1 &&
      (visibility.admissionLevels === null || (
        admissionLevels[sources[edge]] <= visibility.lodLevel &&
        admissionLevels[destinations[edge]] <= visibility.lodLevel
      ))
    );
    const reference = [];
    for (let index = 0; index < edgeCount; index++) {
      const edge = order.at(index);
      if (visible(edge)) reference.push(edge);
    }
    for (const target of [0, 1, 100, 2500, reference.length, edgeCount]) {
      const output = new Uint32Array(target);
      const selected = selectVisibleConnectivityEdges(order, sources, destinations, visibility, target, output);
      assert.equal(selected, Math.min(target, reference.length));
      assert.deepEqual(Array.from(output.subarray(0, selected)), reference.slice(0, selected));
    }
    let count = 0;
    for (let start = 0; start < edgeCount; start += 7_000) {
      count += countVisibleConnectivityEdges(
        sources, destinations, visibility, start, Math.min(edgeCount, start + 7_000),
      );
    }
    assert.equal(count, reference.length);
    assert.equal(isEveryConnectivityCellVisible(visibility), false);
  }
  assert.equal(
    isEveryConnectivityCellVisible({ transparency: new Uint8Array(10).fill(1), admissionLevels: null, lodLevel: -1 }),
    true,
  );
});
