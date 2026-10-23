import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agglomerate,
  clusteringWorkingSetBytes,
  condensedRowRanges,
  dendrogramLeafOrder,
  pairwiseDistanceRows
} from '../assets/js/app/analysis/compute/hierarchical-clustering.js';
import { pearsonCorrelation } from '../assets/js/app/analysis/compute/math-utils.js';
import { ClusteringEngine } from '../assets/js/app/analysis/genes-panel/clustering-engine.js';

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Distance of two items computed directly from the definition. */
function directDistance(a, b, metric) {
  if (metric === 'correlation') return 1 - pearsonCorrelation(a, b);
  if (metric === 'euclidean') {
    let sum = 0;
    for (let k = 0; k < a.length; k++) sum += (a[k] - b[k]) ** 2;
    return Math.sqrt(sum);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let k = 0; k < a.length; k++) {
    dot += a[k] * b[k];
    na += a[k] * a[k];
    nb += b[k] * b[k];
  }
  const denominator = Math.sqrt(na) * Math.sqrt(nb);
  return denominator === 0 ? 1 : 1 - dot / denominator;
}

/**
 * The primitive agglomeration the kernel must equal: each step searches every
 * active pair for the smallest distance (ties: smallest i, then smallest j),
 * merges j into i and applies the Lance-Williams update, in double precision.
 */
function primitive(values, n, m, metric, linkage) {
  const d = Array.from({ length: n }, () => new Float64Array(n));
  const row = i => values.subarray(i * m, (i + 1) * m);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) d[i][j] = d[j][i] = directDistance(row(i), row(j), metric);
  }
  const active = new Array(n).fill(true);
  const size = new Array(n).fill(1);
  const node = Array.from({ length: n }, (_, i) => i);
  const merges = [];
  for (let step = 0; step < n - 1; step++) {
    let bi = -1;
    let bj = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (active[j] && d[i][j] < best) {
          best = d[i][j];
          bi = i;
          bj = j;
        }
      }
    }
    merges.push([node[bi], node[bj], best]);
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === bi || k === bj) continue;
      const x = d[bi][k];
      const y = d[bj][k];
      const v = linkage === 'average'
        ? (x * size[bi] + y * size[bj]) / (size[bi] + size[bj])
        : linkage === 'single' ? Math.min(x, y) : Math.max(x, y);
      d[bi][k] = d[k][bi] = v;
    }
    active[bj] = false;
    size[bi] += size[bj];
    node[bi] = n + step;
  }
  return merges;
}

function kernel(values, n, m, metric, linkage, parts) {
  const ranges = condensedRowRanges(n, parts);
  const blocks = ranges.map(([from, to]) => pairwiseDistanceRows(values, n, m, metric, from, to));
  return agglomerate(blocks, ranges, n, linkage);
}

test('agglomeration equals the primitive global-minimum algorithm, ties included', () => {
  const random = lcg(11);
  const n = 61;
  const m = 7;
  const values = Float32Array.from({ length: n * m }, () => Math.fround(random() * 4 - 1));
  // Exact ties: duplicated items, two constant items, an all-zero item.
  values.copyWithin(5 * m, 0, m);
  values.copyWithin(9 * m, 0, m);
  values.fill(2, 20 * m, 21 * m);
  values.fill(2, 33 * m, 34 * m);
  values.fill(0, 40 * m, 41 * m);
  for (const metric of ['correlation', 'euclidean', 'cosine']) {
    for (const linkage of ['average', 'complete', 'single']) {
      const expected = primitive(values, n, m, metric, linkage);
      for (const parts of [1, 3, 8]) {
        const { left, right, height } = kernel(values, n, m, metric, linkage, parts);
        for (let s = 0; s < n - 1; s++) {
          const label = `${metric}/${linkage}/${parts} merge ${s}`;
          assert.equal(left[s], expected[s][0], label);
          assert.equal(right[s], expected[s][1], label);
          assert.ok(Object.is(height[s], expected[s][2]), `${label}: ${height[s]} vs ${expected[s][2]}`);
        }
      }
    }
  }
});

test('distance blocks are the same numbers however the rows are split', () => {
  const random = lcg(5);
  const n = 50;
  const m = 13;
  const values = Float32Array.from({ length: n * m }, () => Math.fround(random()));
  for (const metric of ['correlation', 'euclidean', 'cosine']) {
    const whole = pairwiseDistanceRows(values, n, m, metric, 0, n - 1);
    for (const parts of [2, 7, 49]) {
      const ranges = condensedRowRanges(n, parts);
      assert.equal(ranges[0][0], 0);
      assert.equal(ranges.at(-1)[1], n - 1);
      const joined = ranges.flatMap(([from, to]) => Array.from(pairwiseDistanceRows(values, n, m, metric, from, to)));
      assert.deepEqual(joined, Array.from(whole), `${metric} in ${parts} parts`);
    }
  }
});

test('leaf order is a permutation in left-first dendrogram order', () => {
  // ((0, 2), (1, 3)) merged at heights 1, 2, 3.
  const left = Int32Array.of(0, 1, 4);
  const right = Int32Array.of(2, 3, 5);
  assert.deepEqual(Array.from(dendrogramLeafOrder(left, right, 4)), [0, 2, 1, 3]);
  assert.deepEqual(Array.from(dendrogramLeafOrder(new Int32Array(0), new Int32Array(0), 1)), [0]);
});

test('the working set is the condensed matrix, one double per pair', () => {
  assert.equal(clusteringWorkingSetBytes(2), 8);
  assert.equal(clusteringWorkingSetBytes(3000), 8 * 3000 * 2999 / 2);
});

test('the engine returns the kernel merges as dendrogram nodes and orders', async () => {
  const random = lcg(23);
  const nRows = 40;
  const nCols = 6;
  const values = Float32Array.from({ length: nRows * nCols }, () => Math.fround(random() * 3));
  const result = await new ClusteringEngine().clusterMatrix({
    matrix: { values, nRows, nCols },
    clusterRows: true,
    clusterCols: true,
    distance: 'correlation',
    linkage: 'average',
    memoryBudgetBytes: 2 ** 20
  });
  const expected = primitive(values, nRows, nCols, 'correlation', 'average');
  const merges = [];
  const stack = [result.rowDendrogram];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.isLeaf) continue;
    merges[node.id - nRows] = [node.left.id, node.right.id, node.height];
    stack.push(node.left, node.right);
  }
  assert.deepEqual(merges, expected);
  const { left, right } = kernel(values, nRows, nCols, 'correlation', 'average', 1);
  assert.deepEqual(result.rowOrder, Array.from(dendrogramLeafOrder(left, right, nRows)));
  assert.equal(result.colOrder.length, nCols);
  assert.equal(new Set(result.colOrder).size, nCols);
});

test('the heatmap draws a dendrogram of any depth, left subtree first', async () => {
  const { default: geneHeatmap } = await import('../assets/js/app/analysis/plots/types/gene-heatmap.js');
  const options = {
    colorscale: 'Viridis',
    showValues: false,
    reverseColorscale: false,
    rangeMode: 'auto',
    showRowDendrogram: true,
    showColDendrogram: false
  };
  const draw = (n, root, order) => geneHeatmap.buildTraces({
    matrix: {
      values: new Float32Array(n),
      genes: Array.from({ length: n }, (_, i) => `g${i}`),
      groupNames: ['a'],
      nRows: n,
      nCols: 1,
      transform: 'none'
    },
    clustering: { rowDendrogram: root, rowOrder: order, colDendrogram: null, colOrder: [0] }
  }, options).find(trace => trace.xaxis === 'x2');
  const build = (n, left, right) => {
    const nodes = Array.from({ length: n }, (_, id) => ({ id, isLeaf: true, height: 0 }));
    for (let s = 0; s < n - 1; s++) {
      nodes.push({ id: n + s, isLeaf: false, height: s + 1, left: nodes[left[s]], right: nodes[right[s]] });
    }
    return nodes[2 * n - 2];
  };
  // Recursive reference of the drawing order.
  const reference = (root, order) => {
    const at = new Map(order.map((id, i) => [id, i]));
    const xs = [];
    const ys = [];
    const walk = node => {
      if (node.isLeaf) return { x: at.get(node.id), y: 0 };
      const l = walk(node.left);
      const r = walk(node.right);
      xs.push(l.x, l.x, null, r.x, r.x, null, l.x, r.x, null);
      ys.push(l.y, node.height, null, r.y, node.height, null, node.height, node.height, null);
      return { x: (l.x + r.x) / 2, y: node.height };
    };
    walk(root);
    return { xs, ys };
  };
  const left = Int32Array.of(0, 1, 4, 3, 6);
  const right = Int32Array.of(2, 5, 7, 8, 9);
  const root = build(6, left, right);
  const order = Array.from(dendrogramLeafOrder(left, right, 6));
  const trace = draw(6, root, order);
  const expected = reference(root, order);
  assert.deepEqual(trace.x, expected.xs);
  assert.deepEqual(trace.y, expected.ys);

  // A single-linkage chain as deep as its 30,000 leaves.
  const n = 30_000;
  const chainLeft = Int32Array.from({ length: n - 1 }, (_, s) => (s === 0 ? 0 : n + s - 1));
  const chainRight = Int32Array.from({ length: n - 1 }, (_, s) => s + 1);
  const chain = draw(n, build(n, chainLeft, chainRight), Array.from(dendrogramLeafOrder(chainLeft, chainRight, n)));
  assert.equal(chain.x.length, 9 * (n - 1));
});
