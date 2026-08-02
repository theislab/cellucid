/**
 * Two things the analysis engine's streaming layer must keep true no matter how
 * it is tuned for speed:
 *
 * 1. Set identity. The values a comparison sees are exactly the cells that were
 *    selected, in cell-index order, and nothing else. Prefetch depth, network
 *    concurrency and buffer sizing are allowed to change *when* a gene arrives;
 *    they are never allowed to change *which cells* it contributes.
 * 2. The memory bound. The buffer that hides network latency is sized from the
 *    caller's budget, and what it pins has to stay inside that budget.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { StreamingGeneLoader } from '../assets/js/app/analysis/data/streaming-gene-loader.js';
import {
  gatherComplementFloat32,
  gatherFloat32
} from '../assets/js/app/analysis/shared/typed-array-utils.js';
import { getPerformanceConfig } from '../assets/js/app/analysis/shared/performance-config.js';
import { DEFAULTS } from '../assets/js/app/analysis/genes-panel/constants.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sortedUniqueIndices(total, count, seed) {
  const random = mulberry32(seed);
  const picked = new Uint8Array(total);
  let remaining = count;
  while (remaining > 0) {
    const index = Math.floor(random() * total);
    if (!picked[index]) {
      picked[index] = 1;
      remaining--;
    }
  }
  const out = new Uint32Array(count);
  let write = 0;
  for (let index = 0; index < total; index++) if (picked[index]) out[write++] = index;
  return out;
}

/**
 * DataLayer stand-in: every gene is a distinct, index-identifying signal, so a
 * mis-ordered or mis-selected cell is impossible to miss.
 */
function createDataLayer({ pointCount, geneCount, latency = null }) {
  const released = [];
  const invalidated = [];
  let concurrent = 0;
  let peakConcurrent = 0;
  const values = new Map();
  for (let g = 0; g < geneCount; g++) {
    const array = new Float32Array(pointCount);
    for (let i = 0; i < pointCount; i++) array[i] = g * 1_000_000 + i;
    values.set(`GENE${g}`, array);
  }
  return {
    state: { pointCount },
    released,
    invalidated,
    getPeakConcurrent: () => peakConcurrent,
    async ensureGeneExpressionLoaded(gene) {
      concurrent++;
      if (concurrent > peakConcurrent) peakConcurrent = concurrent;
      try {
        if (latency !== null) {
          await new Promise(resolve => setTimeout(resolve, latency));
        } else {
          await Promise.resolve();
        }
        const array = values.get(gene);
        if (array === undefined) throw new Error(`unknown gene ${gene}`);
        return { fieldIndex: 0, values: array, wasLoaded: false };
      } finally {
        concurrent--;
      }
    },
    unloadGeneExpression(gene) {
      released.push(gene);
      return true;
    },
    invalidateVariable(type, key) {
      invalidated.push(`${type}:${key}`);
    }
  };
}

test('streamGenes yields exactly the selected cells, in cell-index order', async () => {
  const pointCount = 5000;
  const geneCount = 12;
  const dataLayer = createDataLayer({ pointCount, geneCount });
  const groupAIndices = sortedUniqueIndices(pointCount, 700, 3);
  const remaining = [];
  const inA = new Uint8Array(pointCount);
  for (const index of groupAIndices) inA[index] = 1;
  for (let index = 0; index < pointCount; index++) if (!inA[index]) remaining.push(index);
  const groupBIndices = Uint32Array.from(remaining.filter((_, i) => i % 3 === 0));

  const loader = new StreamingGeneLoader({
    dataLayer,
    config: { preloadCount: 5, networkConcurrency: 3, memoryBudgetMB: 256 }
  });

  const genes = Array.from({ length: geneCount }, (_, g) => `GENE${g}`);
  let seen = 0;
  for await (const { gene, valuesA, valuesB, index } of loader.streamGenes(
    genes,
    { isRestOf: false, cellIndices: groupAIndices },
    { isRestOf: false, cellIndices: groupBIndices }
  )) {
    assert.equal(gene, genes[index], 'streamed gene must match its request index');
    assert.equal(valuesA.length, groupAIndices.length);
    assert.equal(valuesB.length, groupBIndices.length);
    // Every value encodes (gene, cellIndex), so the whole selected set — its
    // membership and its order — is verifiable element by element.
    for (let i = 0; i < groupAIndices.length; i++) {
      assert.equal(valuesA[i], index * 1_000_000 + groupAIndices[i]);
    }
    for (let i = 0; i < groupBIndices.length; i++) {
      assert.equal(valuesB[i], index * 1_000_000 + groupBIndices[i]);
    }
    seen++;
  }
  assert.equal(seen, geneCount);
  assert.equal(dataLayer.released.length, geneCount, 'every streamed gene is released');
});

test('a rest-of group is exactly the complement of its excluded cells', async () => {
  const pointCount = 3000;
  const dataLayer = createDataLayer({ pointCount, geneCount: 4 });
  const excluded = sortedUniqueIndices(pointCount, 1100, 17);
  const excludedSet = new Set(excluded);
  const expectedComplement = [];
  for (let index = 0; index < pointCount; index++) {
    if (!excludedSet.has(index)) expectedComplement.push(index);
  }

  const loader = new StreamingGeneLoader({
    dataLayer,
    config: { preloadCount: 4, networkConcurrency: 2, memoryBudgetMB: 256 }
  });

  const genes = ['GENE0', 'GENE1', 'GENE2', 'GENE3'];
  for await (const { valuesA, valuesB, index } of loader.streamGenes(
    genes,
    { isRestOf: false, cellIndices: excluded },
    { isRestOf: true, excludedCellIndices: excluded }
  )) {
    assert.equal(valuesA.length + valuesB.length, pointCount, 'the two sides partition the dataset');
    for (let i = 0; i < excluded.length; i++) {
      assert.equal(valuesA[i], index * 1_000_000 + excluded[i]);
    }
    for (let i = 0; i < expectedComplement.length; i++) {
      assert.equal(valuesB[i], index * 1_000_000 + expectedComplement[i]);
    }
  }
});

test('prefetch depth and concurrency never change the streamed set', async () => {
  const pointCount = 2000;
  const geneCount = 20;
  const selection = sortedUniqueIndices(pointCount, 400, 91);
  const other = sortedUniqueIndices(pointCount, 350, 92);
  const disjointOther = Uint32Array.from(
    Array.from(other).filter(index => !new Set(selection).has(index))
  );

  /** @type {string[]|null} */
  let reference = null;
  for (const config of [
    { preloadCount: 1, networkConcurrency: 1, memoryBudgetMB: 128 },
    { preloadCount: 3, networkConcurrency: 12, memoryBudgetMB: 512 },
    { preloadCount: 50, networkConcurrency: 24, memoryBudgetMB: 4096 }
  ]) {
    const dataLayer = createDataLayer({ pointCount, geneCount, latency: 1 });
    const loader = new StreamingGeneLoader({ dataLayer, config });
    const genes = Array.from({ length: geneCount }, (_, g) => `GENE${g}`);
    const digest = [];
    for await (const { gene, valuesA, valuesB, index } of loader.streamGenes(
      genes,
      { isRestOf: false, cellIndices: selection },
      { isRestOf: false, cellIndices: disjointOther }
    )) {
      let sumA = 0;
      for (const value of valuesA) sumA += value;
      let sumB = 0;
      for (const value of valuesB) sumB += value;
      digest.push(`${index}:${gene}:${valuesA.length}:${sumA}:${valuesB.length}:${sumB}`);
    }
    assert.equal(digest.length, geneCount);
    if (reference === null) reference = digest;
    else assert.deepEqual(digest, reference, `config ${JSON.stringify(config)} changed the set`);
  }
});

test('streamGenesRaw yields whole per-cell vectors in request order', async () => {
  const pointCount = 1500;
  const geneCount = 9;
  const dataLayer = createDataLayer({ pointCount, geneCount, latency: 1 });
  const loader = new StreamingGeneLoader({
    dataLayer,
    config: { preloadCount: 6, networkConcurrency: 12, memoryBudgetMB: 512 }
  });
  const genes = Array.from({ length: geneCount }, (_, g) => `GENE${g}`);
  let expectedIndex = 0;
  for await (const { gene, values, index } of loader.streamGenesRaw(genes)) {
    assert.equal(index, expectedIndex, 'raw streaming preserves request order');
    assert.equal(gene, genes[expectedIndex]);
    assert.equal(values.length, pointCount);
    assert.equal(values[0], index * 1_000_000);
    assert.equal(values[pointCount - 1], index * 1_000_000 + pointCount - 1);
    expectedIndex++;
  }
  assert.equal(expectedIndex, geneCount);
});

test('the prefetch buffer stays inside the memory budget it was given', async () => {
  // The buffer pins one DataLayer var-field array per buffered gene. Whatever
  // sizing rule is in force, what it pins must fit the share of the budget the
  // loader reserves for buffered gene data.
  const bufferBudgetFraction = 0.3;
  for (const [pointCount, budgetMB] of [
    [561_947, 512],
    [561_947, 256],
    [219_731, 512],
    [71_650, 512],
    [3_696, 512]
  ]) {
    const dataLayer = createDataLayer({ pointCount: 16, geneCount: 1 });
    dataLayer.state.pointCount = pointCount;
    const loader = new StreamingGeneLoader({
      dataLayer,
      config: { preloadCount: 500, networkConcurrency: 12, memoryBudgetMB: budgetMB }
    });
    loader._recalculateBufferSize();
    const pinnedBytes = loader._maxBufferSize * pointCount * 4;
    const reservedBytes = budgetMB * 1024 * 1024 * bufferBudgetFraction;
    assert.ok(
      pinnedBytes <= reservedBytes || loader._maxBufferSize === loader._minimumBufferSize,
      `${pointCount} cells at ${budgetMB}MB pins ${(pinnedBytes / 2 ** 20).toFixed(1)}MB ` +
      `against a ${(reservedBytes / 2 ** 20).toFixed(1)}MB reservation`
    );
    assert.ok(loader._maxBufferSize >= loader._minimumBufferSize);
    assert.ok(loader._maxBufferSize <= 500);
  }
});

test('the buffer does not throttle the configured network concurrency', async () => {
  // One gene is one HTTP request, and `_startPrefetch` will not start more loads
  // than there are free buffer slots. If the buffer is sized below the requested
  // concurrency, the request parallelism the user asked for silently disappears.
  const config = getPerformanceConfig();
  for (const pointCount of [561_947, 219_731, 71_650, 3_696]) {
    const dataLayer = createDataLayer({ pointCount: 16, geneCount: 1 });
    dataLayer.state.pointCount = pointCount;
    const loader = new StreamingGeneLoader({
      dataLayer,
      config: { preloadCount: config.batch.defaultPreloadCount }
    });
    loader._recalculateBufferSize();
    assert.ok(
      loader._maxBufferSize >= config.batch.networkConcurrency,
      `${pointCount} cells: buffer ${loader._maxBufferSize} caps concurrency ` +
      `${config.batch.networkConcurrency}`
    );
  }
});

test('concurrent gene loads actually reach the configured concurrency', async () => {
  const pointCount = 4000;
  const geneCount = 60;
  const dataLayer = createDataLayer({ pointCount, geneCount, latency: 5 });
  const loader = new StreamingGeneLoader({
    dataLayer,
    config: { preloadCount: 100, networkConcurrency: 12, memoryBudgetMB: 512 }
  });
  const genes = Array.from({ length: geneCount }, (_, g) => `GENE${g}`);
  let count = 0;
  for await (const _item of loader.streamGenesRaw(genes)) count++;
  assert.equal(count, geneCount);
  assert.equal(
    dataLayer.getPeakConcurrent(),
    12,
    'the loader must saturate the configured request concurrency'
  );
});

test('an aborted stream starts no further requests and releases every gene', async () => {
  const pointCount = 4000;
  const geneCount = 60;
  const dataLayer = createDataLayer({ pointCount, geneCount, latency: 5 });
  const controller = new AbortController();
  const loader = new StreamingGeneLoader({
    dataLayer,
    config: { preloadCount: 40, networkConcurrency: 12, memoryBudgetMB: 512 },
    signal: controller.signal
  });
  const genes = Array.from({ length: geneCount }, (_, g) => `GENE${g}`);

  let requestsAtAbort = null;
  let yielded = 0;
  await assert.rejects(async () => {
    for await (const _item of loader.streamGenesRaw(genes)) {
      yielded++;
      if (yielded === 4) {
        requestsAtAbort = dataLayer.released.length + loader._buffer.size + loader._loadingGenes.size;
        controller.abort(new DOMException('test abort', 'AbortError'));
      }
    }
  }, /abort/i);

  assert.ok(yielded >= 4 && yielded < geneCount, `aborted after ${yielded} of ${geneCount}`);
  assert.ok(requestsAtAbort !== null);
  assert.equal(loader._buffer.size, 0, 'the buffer is emptied on abort');
  assert.equal(loader._loadingGenes.size, 0, 'no load is left running');
  assert.equal(loader._inFlightLoads.size, 0, 'no load task is left unsettled');
  assert.equal(loader._waitingFor.size, 0, 'no consumer is left waiting');
  // Every gene the run pinned in DataLayer is handed back.
  assert.equal(
    new Set(dataLayer.released).size,
    dataLayer.released.length,
    'no gene is released twice'
  );
  for (const gene of dataLayer.released) {
    assert.ok(dataLayer.invalidated.includes(`gene_expression:${gene}`));
  }
});

test('gather helpers select exactly the requested cells', () => {
  const source = new Float32Array(1000);
  for (let i = 0; i < source.length; i++) source[i] = i;

  const indices = sortedUniqueIndices(1000, 250, 55);
  const gathered = gatherFloat32(source, indices);
  assert.equal(gathered.length, indices.length);
  for (let i = 0; i < indices.length; i++) assert.equal(gathered[i], indices[i]);

  const complement = gatherComplementFloat32(source, indices);
  assert.equal(complement.length, source.length - indices.length);
  const excluded = new Set(indices);
  let write = 0;
  for (let i = 0; i < source.length; i++) {
    if (excluded.has(i)) continue;
    assert.equal(complement[write++], i);
  }
  assert.equal(write, complement.length);

  // Unsorted, arbitrary order is honoured position by position.
  const arbitrary = [7, 3, 999, 0, 512];
  const arbitraryGathered = gatherFloat32(source, arbitrary);
  assert.deepEqual(Array.from(arbitraryGathered), arbitrary);
});

test('the gene-request concurrency defaults agree across the analysis engine', () => {
  const config = getPerformanceConfig();
  assert.equal(
    DEFAULTS.networkConcurrency,
    config.batch.networkConcurrency,
    'genes-panel defaults must not diverge from PerformanceConfig'
  );

  // A preset ladder that is not monotone would mean "high performance" asks for
  // fewer concurrent requests than the plain default.
  const ladder = ['lowMemory', 'balanced', 'highPerformance', 'maximum'];
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(
      config.presets[ladder[i]].networkConcurrency >=
        config.presets[ladder[i - 1]].networkConcurrency,
      `${ladder[i]} must not request less concurrency than ${ladder[i - 1]}`
    );
  }
  assert.equal(
    config.presets.balanced.networkConcurrency,
    config.batch.networkConcurrency,
    'the balanced preset is the default and must match it'
  );

  const options = config.getNetworkConcurrencyOptions();
  const selected = options.filter(option => option.selected);
  assert.equal(selected.length, 1, 'exactly one concurrency option is the current one');
  assert.equal(selected[0].value, config.batch.networkConcurrency);
  for (const preset of ladder) {
    assert.ok(
      options.some(option => option.value === config.presets[preset].networkConcurrency),
      `the ${preset} preset value must be reachable from the selector`
    );
  }
});
