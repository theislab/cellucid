/**
 * Analysis throughput work must not move a single result.
 *
 * - Page data keeps a continuous field's typed-array element type, so a page's
 *   values are the field's own numbers at the field's width (4 bytes a cell for
 *   Float32 instead of a JavaScript number array's 8).
 * - The page-data cache is bounded by the bytes of the values it holds, not
 *   only by its entry count.
 * - A density curve is computed once per page-values array and bandwidth, and
 *   the narrow/wide bandwidths no longer run (and discard) the auto kernel sum
 *   first; the curves are bit-identical to that double computation.
 * - The quantization pool hands a decode to an idle worker instead of queueing
 *   it behind a busy one in round-robin order.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DataLayer } from '../assets/js/app/analysis/data/data-layer.js';
import { LRUCache } from '../assets/js/app/analysis/shared/lru-cache.js';
import { processQuantizationWorkerMessage } from '../assets/js/data/quantization-worker.js';
import { QuantizationWorkerPool } from '../assets/js/data/quantization-worker-pool.js';

const POINT_COUNT = 64;

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function makeLayer({ varFields = [], obsFields = [], pages, options = {} }) {
  return new DataLayer(
    {
      pointCount: POINT_COUNT,
      getHighlightPages: () => pages,
      obsData: { fields: obsFields },
      varData: { fields: varFields },
      ensureFieldLoaded: async () => {},
      ensureVarFieldLoaded: async () => {},
    },
    {
      enableNotifications: false,
      enablePrefetch: false,
      enableVersionTracking: true,
      ...options,
    },
  );
}

function page(id, cellIndices) {
  return {
    id,
    name: `Page ${id}`,
    highlightedGroups: [{
      id: `${id}-group`,
      type: 'lasso',
      label: id,
      enabled: true,
      cellIndices,
      cellCount: cellIndices.length,
    }],
  };
}

const EVEN = Array.from({ length: POINT_COUNT / 2 }, (_, i) => i * 2);
const ODD = Array.from({ length: POINT_COUNT / 2 }, (_, i) => i * 2 + 1);

test('continuous page values keep the field element type and exact numbers', async t => {
  const random = lcg(3);
  const gene = Float32Array.from({ length: POINT_COUNT }, () => random() * 7 - 1);
  gene[5] = NaN;
  const score = Float64Array.from({ length: POINT_COUNT }, () => random() * 1e-3 + 1 / 3);
  const layer = makeLayer({
    pages: [page('a', EVEN), page('b', ODD)],
    varFields: [{ key: 'G1', kind: 'continuous', loaded: true, values: gene }],
    obsFields: [
      { key: 'score', kind: 'continuous', loaded: true, values: score },
      {
        key: 'cluster',
        kind: 'category',
        loaded: true,
        codes: Uint16Array.from({ length: POINT_COUNT }, (_, i) => i % 3),
        categories: ['x', 'y', 'z'],
      },
    ],
  });
  t.after(() => layer.destroy());

  for (const [type, key, source, Expected] of [
    ['gene_expression', 'G1', gene, Float32Array],
    ['continuous_obs', 'score', score, Float64Array],
  ]) {
    const pages = await layer.getDataForPages({ type, variableKey: key, pageIds: ['a', 'b'] });
    for (const pd of pages) {
      assert.ok(pd.values instanceof Expected, `${key} ${pd.pageId} keeps ${Expected.name}`);
      assert.equal(pd.values.length, pd.cellIndices.length);
      assert.equal(pd.cellCount, pd.cellIndices.length);
      for (let i = 0; i < pd.values.length; i++) {
        assert.ok(Object.is(pd.values[i], source[pd.cellIndices[i]]), `${key} cell ${pd.cellIndices[i]}`);
      }
    }
  }

  const categorical = await layer.getDataForPages({
    type: 'categorical_obs', variableKey: 'cluster', pageIds: ['a'],
  });
  assert.ok(Array.isArray(categorical[0].values), 'category names stay a plain array');
  assert.deepEqual(categorical[0].values.slice(0, 4), ['x', 'z', 'y', 'x']);
});

test('an empty page publishes empty values of the field type', async t => {
  const layer = makeLayer({
    pages: [page('a', EVEN), { id: 'empty', name: 'Empty', highlightedGroups: [] }],
    varFields: [{ key: 'G1', kind: 'continuous', loaded: true, values: new Float32Array(POINT_COUNT) }],
  });
  t.after(() => layer.destroy());
  const [, empty] = await layer.getDataForPages({
    type: 'gene_expression', variableKey: 'G1', pageIds: ['a', 'empty'],
  });
  assert.ok(empty.values instanceof Float32Array);
  assert.equal(empty.values.length, 0);
  assert.equal(empty.cellCount, 0);
});

test('the page-data cache is bounded by the bytes of the values it holds', async t => {
  const genes = Array.from({ length: 6 }, (_, g) => ({
    key: `G${g}`,
    kind: 'continuous',
    loaded: true,
    values: Float32Array.from({ length: POINT_COUNT }, (_, i) => g + i),
  }));
  // Each result is one 32-cell Float32 page: 128 bytes. Three fit in 400.
  const layer = makeLayer({
    pages: [page('a', EVEN)],
    varFields: genes,
    options: { cacheMaxBytes: 400 },
  });
  t.after(() => layer.destroy());

  const first = await layer.getDataForPages({ type: 'gene_expression', variableKey: 'G0', pageIds: ['a'] });
  assert.equal(layer._dataCache.getStats().bytes, 128);
  assert.equal(
    await layer.getDataForPages({ type: 'gene_expression', variableKey: 'G0', pageIds: ['a'] }),
    first,
    'a cached result is served by identity'
  );
  for (let g = 1; g < 6; g++) {
    await layer.getDataForPages({ type: 'gene_expression', variableKey: `G${g}`, pageIds: ['a'] });
  }
  const stats = layer._dataCache.getStats();
  assert.equal(stats.size, 3, 'the oldest results were evicted by bytes');
  assert.equal(stats.bytes, 384);
  assert.equal(stats.maxBytes, 400);
  assert.notEqual(
    await layer.getDataForPages({ type: 'gene_expression', variableKey: 'G0', pageIds: ['a'] }),
    first,
    'an evicted result is rebuilt'
  );
});

test('LRUCache byte budget accounting', () => {
  assert.throws(() => new LRUCache({ maxBytes: 10 }), /sizeOf/);
  assert.throws(() => new LRUCache({ maxBytes: -1, sizeOf: () => 0 }), /maxBytes/);
  const evicted = [];
  const cache = new LRUCache({
    maxSize: 10,
    maxBytes: 100,
    sizeOf: value => value.length,
    onEvict: key => evicted.push(key),
  });
  cache.set('a', 'x'.repeat(40)).set('b', 'x'.repeat(40));
  assert.equal(cache.getStats().bytes, 80);
  cache.get('a');
  cache.set('c', 'x'.repeat(30));
  assert.deepEqual(evicted, ['b'], 'the least recently used entry goes first');
  assert.equal(cache.getStats().bytes, 70);
  cache.set('a', 'x'.repeat(10));
  assert.equal(cache.getStats().bytes, 40, 'replacing an entry replaces its bytes');
  cache.set('huge', 'x'.repeat(101));
  assert.equal(cache.has('huge'), false, 'a value over the whole budget is not kept');
  assert.equal(cache.getStats().bytes, 40);
  assert.equal(cache.delete('c'), true);
  assert.equal(cache.getStats().bytes, 10);
  cache.clear();
  assert.equal(cache.getStats().bytes, 0);
  assert.throws(
    () => new LRUCache({ maxBytes: 5, sizeOf: () => NaN }).set('k', 1),
    /sizeOf/
  );
});

/**
 * The density plot's KDE as it was before this change, verbatim: the auto
 * curve first, then, for a bandwidth multiplier other than 1, a second curve
 * that replaced it.
 */
async function legacyDensity(values, bandwidthMult) {
  const { filterFiniteNumbers, getFiniteMinMax, std } = await import(
    '../assets/js/app/analysis/shared/number-utils.js'
  );
  const { DistinctValueIndex, MAX_TABULATED_DISTINCT_VALUES } = await import(
    '../assets/js/app/analysis/compute/math-utils.js'
  );
  function weightedSupport(data) {
    const index = new DistinctValueIndex();
    const counts = new Float64Array(MAX_TABULATED_DISTINCT_VALUES);
    for (let i = 0; i < data.length; i++) {
      const number = index.numberOf(data[i]);
      if (number === -1) return { values: data, weights: new Float64Array(data.length).fill(1) };
      counts[number] += 1;
    }
    return { values: index.values.subarray(0, index.size), weights: counts.subarray(0, index.size) };
  }
  function kernelDensity(data, bandwidth = 'auto', nPoints = 100) {
    if (!data || data.length === 0) return { x: [], y: [] };
    const validData = filterFiniteNumbers(data);
    if (validData.length === 0) return { x: [], y: [] };
    const n = validData.length;
    const { min, max } = getFiniteMinMax(validData);
    const range = max - min;
    if (range === 0) return { x: [min], y: [1] };
    let h = bandwidth;
    if (bandwidth === 'auto') {
      h = 1.06 * std(validData) * Math.pow(n, -0.2);
      if (h <= 0 || !Number.isFinite(h)) h = range / 10;
    }
    const padding = h * 3;
    const x = [];
    const step = (range + 2 * padding) / (nPoints - 1);
    for (let i = 0; i < nPoints; i++) x.push(min - padding + i * step);
    const { values: support, weights } = weightedSupport(validData);
    const y = x.map(xi => {
      let sum = 0;
      for (let k = 0; k < support.length; k++) {
        const u = (xi - support[k]) / h;
        sum += weights[k] * (Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI));
      }
      return sum / (n * h);
    });
    return { x, y };
  }
  const finite = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  let { x, y } = kernelDensity(finite, 'auto');
  if (bandwidthMult !== 1 && finite.length > 0) {
    const h = 1.06 * std(finite) * Math.pow(finite.length, -0.2) * bandwidthMult;
    ({ x, y } = kernelDensity(finite, h));
  }
  return { x, y };
}

test('density curves are bit-identical to the double computation and computed once', async () => {
  const { default: densityplot } = await import(
    '../assets/js/app/analysis/plots/types/densityplot.js'
  );
  const random = lcg(19);
  const quantized = Float32Array.from({ length: 4000 }, () => (
    random() < 0.6 ? 0 : Math.fround(Math.round(random() * 254) * (2.9 / 254))
  ));
  const continuous = Float32Array.from({ length: 3000 }, () => Math.fround(random() * 4 - 2));
  continuous[7] = NaN;
  // More distinct values than the tabulation bound: summed value by value,
  // over the page's own Float32 values with unit weights.
  const distinct = Float32Array.from({ length: 6000 }, () => Math.fround(random() * 8 - 4));
  const pageData = [
    { pageId: 'q', pageName: 'Q', values: quantized },
    { pageId: 'c', pageName: 'C', values: continuous },
    { pageId: 'h', pageName: 'H', values: distinct },
    { pageId: 'e', pageName: 'E', values: new Float32Array(0) },
  ];
  for (const [bandwidth, mult] of [['auto', 1], ['narrow', 0.5], ['wide', 2]]) {
    const options = { ...densityplot.defaultOptions, bandwidth };
    const traces = densityplot.buildTraces(pageData, options, null);
    assert.equal(traces.length, 3);
    for (const [index, trace] of traces.entries()) {
      const expected = await legacyDensity(Array.from(pageData[index].values), mult);
      assert.equal(trace.x.length, expected.x.length);
      for (let i = 0; i < expected.x.length; i++) {
        assert.ok(Object.is(trace.x[i], expected.x[i]), `${bandwidth} ${trace.name} x${i}`);
        assert.ok(Object.is(trace.y[i], expected.y[i]), `${bandwidth} ${trace.name} y${i}`);
      }
    }
    // A redraw for an option that does not touch the curve reuses it.
    const again = densityplot.buildTraces(pageData, { ...options, fillOpacity: 80, logY: true }, null);
    assert.equal(again[0].x, traces[0].x);
    assert.equal(again[0].y, traces[0].y);
    const csv = densityplot.exportCSV(pageData, options);
    assert.equal(csv.rows.length, traces.reduce((sum, trace) => sum + trace.x.length, 0));
    assert.equal(csv.rows[0].density, traces[0].y[0].toFixed(6));
  }
});

function installHoldingWorkers(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const instances = [];
  class HoldingWorker {
    constructor() {
      this.held = [];
      this.hold = false;
      this.received = 0;
      this.onmessage = null;
      this.onerror = null;
      instances.push(this);
    }
    postMessage(message) {
      this.received++;
      if (this.hold) {
        this.held.push(message);
        return;
      }
      void this.reply(message);
    }
    async reply(message) {
      const data = await processQuantizationWorkerMessage(message);
      this.onmessage?.({ data });
    }
    release() {
      this.hold = false;
      for (const message of this.held.splice(0)) void this.reply(message);
    }
    terminate() {}
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: HoldingWorker });
  t.after(() => {
    if (original === undefined) delete globalThis.Worker;
    else Object.defineProperty(globalThis, 'Worker', original);
  });
  return instances;
}

test('a quantized decode goes to an idle worker, never behind a busy one', { timeout: 10_000 }, async t => {
  const task = () => ({
    buffer: Uint8Array.of(0, 254).buffer,
    gzipOutputBytes: null,
    dtype: 'uint8',
    bits: 8,
    minValue: 0,
    maxValue: 1,
  });
  const workers = installHoldingWorkers(t);
  const pool = new QuantizationWorkerPool({ poolSize: 2 });
  assert.equal(await pool.init(), true);
  workers[0].hold = true;
  const slow = pool.dequantizeToFloat32(task());
  // Worker 0 is busy for as long as the test holds it; every later decode must
  // run on worker 1 as soon as it is idle, which round-robin did not do.
  for (let i = 0; i < 4; i++) {
    const values = await pool.dequantizeToFloat32(task());
    assert.deepEqual(Array.from(values), [0, 1]);
  }
  assert.equal(workers[0].received, 1);
  assert.equal(workers[1].received, 4);
  workers[0].release();
  assert.deepEqual(Array.from(await slow), [0, 1]);
  assert.equal(pool._pending.size, 0);
});

test('kernel density slices computed apart join into the one-thread curve', async () => {
  const { executeOperation } = await import('../assets/js/app/analysis/compute/operation-handlers.js');
  const { OperationType } = await import('../assets/js/app/analysis/compute/operations.js');
  const { kernelDensityAt } = await import('../assets/js/app/analysis/compute/math-utils.js');
  const random = lcg(77);
  const support = Float64Array.from({ length: 5000 }, () => Math.fround(random() * 6 - 3));
  const weights = new Float64Array(support.length).fill(1);
  const xs = Float64Array.from({ length: 100 }, (_, i) => -3.5 + i * 0.07);
  const whole = kernelDensityAt(support, weights, xs, 0.11, support.length);
  const joined = new Float64Array(xs.length);
  for (let start = 0; start < xs.length; start += 13) {
    const { density } = executeOperation(OperationType.COMPUTE_KERNEL_DENSITY, {
      support, weights, xs: xs.slice(start, start + 13), bandwidth: 0.11, count: support.length,
    });
    joined.set(density, start);
  }
  for (let i = 0; i < xs.length; i++) assert.ok(Object.is(joined[i], whole[i]), `point ${i}`);
  assert.throws(
    () => executeOperation(OperationType.COMPUTE_KERNEL_DENSITY, {
      support: [1], weights, xs, bandwidth: 1, count: 1,
    }),
    /Float64Array/
  );
  assert.throws(
    () => executeOperation(OperationType.COMPUTE_KERNEL_DENSITY, {
      support, weights, xs, bandwidth: 0, count: 1,
    }),
    /bandwidth/
  );
});

test('order statistics are selected, not sorted, and stay the sorted values', async () => {
  const { median } = await import('../assets/js/app/analysis/shared/number-utils.js');
  const { PlotFactory } = await import('../assets/js/app/analysis/plots/plot-factory.js');
  const random = lcg(5150);
  const sortedMedian = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  };
  for (const length of [1, 2, 3, 10, 999, 5000, 5001]) {
    for (const values of [
      Array.from({ length }, () => Math.fround(random() * 100 - 50)),
      Float32Array.from({ length }, () => Math.round(random() * 7) / 4),
    ]) {
      assert.ok(Object.is(median(values), sortedMedian(values)), `median of ${length}`);
    }
  }
  const values = Float32Array.from({ length: 4001 }, () => Math.fround(random() * 9));
  const { rows } = PlotFactory.exportDistributionCSV(
    [{ pageId: 'p', pageName: 'P', values, variableInfo: { name: 'v' } }],
    { metadata: { plotType: 'boxplot' } }
  );
  const sorted = Array.from(values).sort((a, b) => a - b);
  const n = sorted.length;
  assert.equal(rows[0].min, sorted[0].toFixed(4));
  assert.equal(rows[0].q1, sorted[Math.floor(n * 0.25)].toFixed(4));
  assert.equal(rows[0].median, sortedMedian(sorted).toFixed(4));
  assert.equal(rows[0].q3, sorted[Math.floor(n * 0.75)].toFixed(4));
  assert.equal(rows[0].max, sorted[n - 1].toFixed(4));
});
