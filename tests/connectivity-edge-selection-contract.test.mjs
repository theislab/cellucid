/**
 * A pane shows the first K of its visible connectivity edges in one fixed
 * random order (connectivity-edge-selection.js): exactly those records, in
 * that order, whichever walk selects them.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONNECTIVITY_EDGE_ORDER_SEED,
  connectivityVisibleCells,
  countVisibleConnectivityEdges,
  createConnectivityEdgeIndex,
  createConnectivityEdgeOrder,
  createConnectivitySelectionScratch,
  selectConnectivityEdges,
} from '../assets/js/rendering/connectivity-edge-selection.js';
import { connectivityEdgesFromPairs, edgeListOf } from './helpers/connectivity-edges.mjs';

/**
 * The order's definition, computed round by round with no tables: a
 * four-round Feistel network of `mix32(half ^ key)` on the next power of two
 * (at least 4), cycle walking past the edge count.
 */
function referenceOrder(edgeCount, seed = CONNECTIVITY_EDGE_ORDER_SEED) {
  const mix32 = value => {
    let x = value >>> 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x7feb352d);
    x ^= x >>> 15;
    x = Math.imul(x, 0x846ca68b);
    x ^= x >>> 16;
    return x >>> 0;
  };
  let bits = 2;
  while (2 ** bits < edgeCount) bits++;
  const high = Math.ceil(bits / 2);
  const low = bits - high;
  const highMask = (2 ** high - 1) >>> 0;
  const lowMask = (2 ** low - 1) >>> 0;
  const keys = [];
  let state = mix32(seed ^ 0x9e3779b9);
  for (let round = 0; round < 4; round++) {
    state = mix32(state + 0x6d2b79f5);
    keys.push(state);
  }
  const permute = value => {
    const a = Math.floor(value / 2 ** low);
    const b = value % 2 ** low;
    const c = (a ^ (mix32(b ^ keys[0]) & highMask)) >>> 0;
    const d = (b ^ (mix32(c ^ keys[1]) & lowMask)) >>> 0;
    const e = (c ^ (mix32(d ^ keys[2]) & highMask)) >>> 0;
    const f = (d ^ (mix32(e ^ keys[3]) & lowMask)) >>> 0;
    return e * 2 ** low + f;
  };
  return index => {
    let value = permute(index);
    while (value >= edgeCount) value = permute(value);
    return value;
  };
}

test('the order is its definition, a bijection of [0, E) at every size, and rankOf inverts it', () => {
  for (const edgeCount of [0, 1, 2, 3, 4, 5, 15, 16, 17, 1000, 4096, 65_535, 65_537, 300_001]) {
    const order = createConnectivityEdgeOrder(edgeCount);
    const reference = referenceOrder(edgeCount);
    const seen = new Uint8Array(edgeCount);
    for (let index = 0; index < edgeCount; index++) {
      const edge = order.at(index);
      assert.equal(edge, reference(index), `${edgeCount}: rank ${index}`);
      assert.equal(seen[edge], 0, `${edgeCount}: ${edge} twice`);
      seen[edge] = 1;
      assert.equal(order.rankOf(edge), index);
    }
  }
});

test('the order is fixed by its key, differs between keys, and holds exact ids beyond 2^24', () => {
  const a = createConnectivityEdgeOrder(10_000);
  const b = createConnectivityEdgeOrder(10_000);
  const c = createConnectivityEdgeOrder(10_000, CONNECTIVITY_EDGE_ORDER_SEED + 1);
  const prefix = order => Array.from({ length: 64 }, (_value, index) => order.at(index));
  assert.deepEqual(prefix(a), prefix(b));
  assert.notDeepEqual(prefix(a), prefix(c));
  const big = createConnectivityEdgeOrder(4_000_000_000);
  const reference = referenceOrder(4_000_000_000);
  const seen = new Set();
  for (const index of [0, 1, 16_777_216, 16_777_217, 2 ** 31, 3_999_999_999]) {
    const edge = big.at(index);
    assert.equal(edge, reference(index));
    assert.ok(Number.isInteger(edge) && edge >= 0 && edge < 4_000_000_000);
    assert.ok(!seen.has(edge));
    seen.add(edge);
    assert.equal(big.rankOf(edge), index);
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

/** A random graph as the reader worker hands it over: unique pairs, source < destination, ordered by source. */
function randomGraph(cellCount, edgeCount, seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const keys = new Set();
  while (keys.size < edgeCount) {
    const a = next() % cellCount;
    const b = next() % cellCount;
    if (a !== b) keys.add(Math.min(a, b) * cellCount + Math.max(a, b));
  }
  const sorted = Array.from(keys).sort((x, y) => x - y);
  return connectivityEdgesFromPairs(
    sorted.map(key => Math.floor(key / cellCount)),
    sorted.map(key => key % cellCount),
    cellCount,
    sorted.map((_key, edge) => 1 + (edge % 7)),
  );
}

function visibilityOf(cellCount, fraction, seed) {
  let state = seed >>> 0;
  return Uint8Array.from({ length: cellCount }, () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return (state >>> 8) / 2 ** 24 < fraction ? 1 : 0;
  });
}

test('selection writes exactly the first K visible records of the order, by either walk, with exact counts', () => {
  const cellCount = 3000;
  const edgeCount = 40_000;
  const graph = randomGraph(cellCount, edgeCount, 7);
  const order = createConnectivityEdgeOrder(edgeCount);
  const strengthBits = new Uint32Array(edgeListOf(graph).strength.buffer);
  const admissionLevels = Uint8Array.from({ length: cellCount }, (_value, cell) => cell % 5);
  const walks = new Set();
  // Dense visibility is selected by the ordered scan, sparse visibility by
  // the visible-cell walk (which also returns the count).
  for (const fraction of [1, 0.97, 0.6, 0.25, 0.08, 0.02, 0]) {
    const transparency = visibilityOf(cellCount, fraction, 99);
    for (const [admission, lodLevel] of [[null, -1], [admissionLevels, 2]]) {
      const visibility = { transparency, admissionLevels: admission, lodLevel };
      const visible = edge => {
        const s = edgeListOf(graph).sources[edge];
        const d = edgeListOf(graph).destinations[edge];
        return transparency[s] === 1 && transparency[d] === 1 &&
          (admission === null || (admission[s] <= lodLevel && admission[d] <= lodLevel));
      };
      const reference = [];
      for (let rank = 0; rank < edgeCount; rank++) {
        const edge = order.at(rank);
        if (visible(edge)) reference.push(edge);
      }
      {
        for (const target of [0, 1, 100, 2500, reference.length, edgeCount]) {
          const index = createConnectivityEdgeIndex(graph);
          const { mask } = connectivityVisibleCells(visibility, null);
          const output = new Uint32Array(target * 3);
          const { shown, visibleCount } = selectConnectivityEdges(
            index, mask, target, output, createConnectivitySelectionScratch(),
          );
          walks.add(visibleCount === null ? 'scan' : 'counted');
          const label = `fraction ${fraction}, lod ${lodLevel}, K ${target}`;
          assert.equal(shown, Math.min(target, reference.length), label);
          for (let record = 0; record < shown; record++) {
            const edge = reference[record];
            assert.deepEqual(
              Array.from(output.subarray(record * 3, record * 3 + 3)),
              [edgeListOf(graph).sources[edge], edgeListOf(graph).destinations[edge], strengthBits[edge]],
              `${label}: record ${record}`,
            );
          }
          if (visibleCount !== null) assert.equal(visibleCount, reference.length, label);
          const counted = mask === null ? edgeCount : countVisibleConnectivityEdges(index, mask, 0, cellCount);
          assert.equal(counted, reference.length, label);
        }
      }
    }
  }
  assert.deepEqual([...walks].sort(), ['counted', 'scan']);
});

test('the visible-cell mask is the transparency itself, LOD-filtered, or null when every cell is visible', () => {
  const transparency = Uint8Array.from([1, 0, 1, 1]);
  assert.equal(connectivityVisibleCells(null, null).mask, null);
  assert.equal(connectivityVisibleCells({ transparency, admissionLevels: null, lodLevel: -1 }, null).mask, transparency);
  const all = new Uint8Array(4).fill(1);
  assert.equal(connectivityVisibleCells({ transparency: all, admissionLevels: null, lodLevel: -1 }, null).mask, null);
  const lod = connectivityVisibleCells(
    { transparency, admissionLevels: Uint8Array.from([0, 0, 3, 1]), lodLevel: 1 }, null,
  );
  assert.deepEqual(Array.from(lod.mask), [1, 0, 0, 1]);
  assert.equal(
    connectivityVisibleCells({ transparency: all, admissionLevels: new Uint8Array(4), lodLevel: 0 }, lod.scratch).mask,
    null,
  );
});
