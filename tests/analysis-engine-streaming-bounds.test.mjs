/**
 * Two things the analysis engine's streaming layer must keep true no matter how
 * it is tuned for speed:
 *
 * 1. Set identity. The values a comparison sees are exactly the cells that were
 *    selected, in cell-index order, and nothing else. The read-ahead the run
 *    tuner chooses is allowed to change *when* a gene arrives; it is never
 *    allowed to change *which cells* it contributes.
 * 2. The read-ahead is the tuner's: the loader keeps exactly as many genes
 *    buffered or in flight as the tuner says, and tells it about every read.
 *    (How the tuner sizes it, inside the memory budget, is
 *    `analysis-run-tuner-contract.test.mjs`.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { StreamingGeneLoader } from '../assets/js/app/analysis/data/streaming-gene-loader.js';
import {
  createTwoGroupContext,
  splitTwoGroups
} from '../assets/js/app/analysis/compute/gene-statistics.js';

/** A tuner that reads `depth` genes ahead and records what it is told. */
function fixedTuner(depth) {
  const reads = [];
  return {
    reads,
    pressure: 0,
    prefetchDepth: () => depth,
    observeRead(read) { reads.push(read); },
    setReadsPending() {},
    onPressure() { this.pressure++; },
  };
}

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

/** The dense values a sample stands for. */
function denseOf(sample) {
  const out = new Float64Array(sample.length);
  for (let k = 0; k < sample.indices.length; k++) out[sample.indices[k]] = sample.values[k];
  return out;
}

/**
 * The two groups' values of a gene column, split where differential
 * expression splits them (one byte of membership per cell, groups in cell
 * order).
 */
function splitColumn(values, groupA, groupB, pointCount) {
  const membership = group => {
    const mask = new Uint8Array(pointCount);
    if (group.isRestOf) {
      mask.fill(1);
      for (const cell of group.excludedCellIndices) mask[cell] = 0;
    } else {
      for (const cell of group.cellIndices) mask[cell] = 1;
    }
    return mask;
  };
  const inA = membership(groupA);
  const inB = membership(groupB);
  const groupOfCell = new Uint8Array(pointCount);
  for (let cell = 0; cell < pointCount; cell++) {
    groupOfCell[cell] = inA[cell] ? 1 : (inB[cell] ? 2 : 0);
  }
  const { sampleA, sampleB } = splitTwoGroups(values, createTwoGroupContext(groupOfCell));
  return { valuesA: denseOf(sampleA), valuesB: denseOf(sampleB) };
}

/**
 * DataLayer stand-in: every gene is a distinct, index-identifying signal, so a
 * mis-ordered or mis-selected cell is impossible to miss. A gene is read as
 * its non-zero entries, owned by the reader, unless it is `shown` (a view
 * holds it): then it is the shared dense array.
 */
function createDataLayer({ pointCount, geneCount, latency = null, shown = new Set() }) {
  let concurrent = 0;
  let peakConcurrent = 0;
  const values = new Map();
  for (let g = 0; g < geneCount; g++) {
    const array = new Float32Array(pointCount);
    for (let i = 0; i < pointCount; i++) array[i] = g * 1_000_000 + i;
    values.set(`GENE${g}`, array);
  }
  const sparseOf = array => {
    const indices = [];
    for (let i = 0; i < array.length; i++) if (array[i] !== 0) indices.push(i);
    return {
      length: array.length,
      indices: Uint32Array.from(indices),
      values: Float32Array.from(indices, i => array[i])
    };
  };
  return {
    state: { pointCount },
    getPeakConcurrent: () => peakConcurrent,
    async readGeneColumn(gene, options) {
      assert.equal(options.priority, 'bulk');
      assert.ok(options.signal instanceof AbortSignal);
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
        return shown.has(gene)
          ? { fieldIndex: 0, values: array, owned: false }
          : { fieldIndex: 0, values: sparseOf(array), owned: true };
      } finally {
        concurrent--;
      }
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
    tuner: fixedTuner(5)
  });

  const genes = Array.from({ length: geneCount }, (_, g) => `GENE${g}`);
  const groupA = { isRestOf: false, cellIndices: groupAIndices };
  const groupB = { isRestOf: false, cellIndices: groupBIndices };
  let seen = 0;
  for await (const { gene, values, index } of loader.streamGenesRaw(genes)) {
    assert.equal(gene, genes[index], 'streamed gene must match its request index');
    const { valuesA, valuesB } = splitColumn(values, groupA, groupB, pointCount);
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
    tuner: fixedTuner(4)
  });

  const genes = ['GENE0', 'GENE1', 'GENE2', 'GENE3'];
  const groupA = { isRestOf: false, cellIndices: excluded };
  const groupB = { isRestOf: true, excludedCellIndices: excluded };
  for await (const { values, index } of loader.streamGenesRaw(genes)) {
    const { valuesA, valuesB } = splitColumn(values, groupA, groupB, pointCount);
    assert.equal(valuesA.length + valuesB.length, pointCount, 'the two sides partition the dataset');
    for (let i = 0; i < excluded.length; i++) {
      assert.equal(valuesA[i], index * 1_000_000 + excluded[i]);
    }
    for (let i = 0; i < expectedComplement.length; i++) {
      assert.equal(valuesB[i], index * 1_000_000 + expectedComplement[i]);
    }
  }
});

test('the read-ahead never changes the streamed set', async () => {
  const pointCount = 2000;
  const geneCount = 20;
  const selection = sortedUniqueIndices(pointCount, 400, 91);
  const other = sortedUniqueIndices(pointCount, 350, 92);
  const disjointOther = Uint32Array.from(
    Array.from(other).filter(index => !new Set(selection).has(index))
  );

  /** @type {string[]|null} */
  let reference = null;
  for (const depth of [1, 3, 50]) {
    const dataLayer = createDataLayer({ pointCount, geneCount, latency: 1 });
    const loader = new StreamingGeneLoader({ dataLayer, tuner: fixedTuner(depth) });
    const genes = Array.from({ length: geneCount }, (_, g) => `GENE${g}`);
    const digest = [];
    const groupA = { isRestOf: false, cellIndices: selection };
    const groupB = { isRestOf: false, cellIndices: disjointOther };
    for await (const { gene, values, index } of loader.streamGenesRaw(genes)) {
      const { valuesA, valuesB } = splitColumn(values, groupA, groupB, pointCount);
      let sumA = 0;
      for (const value of valuesA) sumA += value;
      let sumB = 0;
      for (const value of valuesB) sumB += value;
      digest.push(`${index}:${gene}:${valuesA.length}:${sumA}:${valuesB.length}:${sumB}`);
    }
    assert.equal(digest.length, geneCount);
    if (reference === null) reference = digest;
    else assert.deepEqual(digest, reference, `read-ahead ${depth} changed the set`);
  }
});

test('streamGenesRaw yields the values of every gene in request order', async () => {
  const pointCount = 1500;
  const geneCount = 9;
  const dataLayer = createDataLayer({ pointCount, geneCount, latency: 1 });
  const loader = new StreamingGeneLoader({
    dataLayer,
    tuner: fixedTuner(6)
  });
  const genes = Array.from({ length: geneCount }, (_, g) => `GENE${g}`);
  let expectedIndex = 0;
  for await (const { gene, values, index } of loader.streamGenesRaw(genes)) {
    assert.equal(index, expectedIndex, 'raw streaming preserves request order');
    assert.equal(gene, genes[expectedIndex]);
    assert.equal(values.length, pointCount);
    const dense = new Float32Array(pointCount);
    values.indices.forEach((cell, k) => { dense[cell] = values.values[k]; });
    assert.equal(dense[0], index * 1_000_000);
    assert.equal(dense[pointCount - 1], index * 1_000_000 + pointCount - 1);
    expectedIndex++;
  }
  assert.equal(expectedIndex, geneCount);
});

test('the loader reads exactly as far ahead as the tuner says, and reports every read', async () => {
  const pointCount = 4000;
  const geneCount = 60;
  for (const depth of [1, 7, 12]) {
    const dataLayer = createDataLayer({ pointCount, geneCount, latency: 5 });
    const tuner = fixedTuner(depth);
    const loader = new StreamingGeneLoader({ dataLayer, tuner });
    const genes = Array.from({ length: geneCount }, (_, g) => `GENE${g}`);
    let count = 0;
    for await (const _item of loader.streamGenesRaw(genes)) count++;
    assert.equal(count, geneCount);
    assert.equal(dataLayer.getPeakConcurrent(), depth, `read-ahead ${depth} is filled and never exceeded`);
    assert.equal(tuner.reads.length, geneCount, 'every read is reported to the tuner');
    for (const read of tuner.reads) {
      assert.ok(read.bytes > 0 && read.ms >= 0, 'a read is reported with its bytes and time');
    }
  }
});

test('an aborted stream starts no further requests and lets go of every gene', async () => {
  const pointCount = 4000;
  const geneCount = 60;
  const dataLayer = createDataLayer({ pointCount, geneCount, latency: 5 });
  const controller = new AbortController();
  const loader = new StreamingGeneLoader({
    dataLayer,
    tuner: fixedTuner(40),
    signal: controller.signal
  });
  const genes = Array.from({ length: geneCount }, (_, g) => `GENE${g}`);

  let requestsAtAbort = null;
  let yielded = 0;
  await assert.rejects(async () => {
    for await (const _item of loader.streamGenesRaw(genes)) {
      yielded++;
      if (yielded === 4) {
        requestsAtAbort = loader._buffer.size + loader._loadingGenes.size;
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
});

test('readCellSubset reads two named groups by cell when the source can, with the same values and no gene loaded whole', async () => {
  const pointCount = 3000;
  const geneCount = 9;
  const groupAIndices = sortedUniqueIndices(pointCount, 40, 11);
  const inA = new Set(groupAIndices);
  const groupBIndices = Uint32Array.from(
    [...sortedUniqueIndices(pointCount, 60, 12)].filter(cell => !inA.has(cell))
  );
  const genes = Array.from({ length: geneCount }, (_, g) => `GENE${g}`);
  const asked = [];
  const subsetLayer = createDataLayer({ pointCount, geneCount });
  const columnsLoaded = [];
  const read = subsetLayer.readGeneColumn;
  subsetLayer.readGeneColumn = (gene, options) => {
    columnsLoaded.push(gene);
    return read(gene, options);
  };
  // A source read by cell: genes 0, 3, 6 ... are zero in every cell (absent
  // entries), the others as the column source has them.
  subsetLayer.readGeneCellSubset = async (geneKeys, cells, { signal }) => {
    assert.ok(signal instanceof AbortSignal);
    asked.push([geneKeys, Array.from(cells)]);
    const pointers = new Float64Array(geneKeys.length + 1);
    const cellIndex = [];
    const values = [];
    geneKeys.forEach((gene, g) => {
      const number = Number(gene.slice(4));
      if (number % 3 !== 0) {
        cells.forEach((cell, position) => {
          cellIndex.push(position);
          values.push(number * 1_000_000 + cell);
        });
      }
      pointers[g + 1] = cellIndex.length;
    });
    return { pointers, cellIndex: Int32Array.from(cellIndex), values: Float32Array.from(values) };
  };
  const loader = new StreamingGeneLoader({
    dataLayer: subsetLayer,
    tuner: fixedTuner(4)
  });
  const block = await loader.readCellSubset(genes, groupAIndices, groupBIndices);
  assert.equal(asked.length, 1, 'one read for every gene');
  const union = asked[0][1];
  assert.deepEqual(union, [...union].sort((a, b) => a - b), 'the cells are read in cell order');
  assert.equal(union.length, groupAIndices.length + groupBIndices.length);
  assert.deepEqual(columnsLoaded, [], 'no gene is loaded whole');
  // Each union position is labelled with its group.
  for (let position = 0; position < union.length; position++) {
    assert.equal(block.groupOfPosition[position], inA.has(union[position]) ? 1 : 2);
  }
  // Split where differential expression splits it, each gene's groups hold
  // exactly their cells' values, in cell order.
  const context = createTwoGroupContext(block.groupOfPosition);
  genes.forEach((gene, index) => {
    const from = block.pointers[index];
    const to = block.pointers[index + 1];
    const { sampleA, sampleB } = splitTwoGroups({
      length: union.length,
      indices: Uint32Array.from(block.cellIndex.subarray(from, to)),
      values: block.values.subarray(from, to)
    }, context);
    const expected = cell => (index % 3 === 0 ? 0 : index * 1_000_000 + cell);
    assert.deepEqual(Array.from(denseOf(sampleA)), Array.from(groupAIndices, expected), gene);
    assert.deepEqual(Array.from(denseOf(sampleB)), Array.from(groupBIndices, expected), gene);
  });

  // A source that answers null (columns are cheaper) leaves the genes to be
  // read by column.
  const columnLayer = createDataLayer({ pointCount, geneCount });
  columnLayer.readGeneCellSubset = async () => null;
  const byGene = new StreamingGeneLoader({ dataLayer: columnLayer, tuner: fixedTuner(4) });
  assert.equal(await byGene.readCellSubset(genes, groupAIndices, groupBIndices), null);
});

test('a streamed gene is owned by its run unless a view holds it', async () => {
  const pointCount = 64;
  const genes = ['GENE0', 'GENE1', 'GENE2'];
  // GENE1 is loaded for a view: it is streamed as the shared array, not owned.
  const dataLayer = createDataLayer({ pointCount, geneCount: 3, shown: new Set(['GENE1']) });
  const loader = new StreamingGeneLoader({
    dataLayer,
    tuner: fixedTuner(3)
  });
  const owned = {};
  for await (const item of loader.streamGenesRaw(genes)) owned[item.gene] = item.owned;
  assert.deepEqual(owned, { GENE0: true, GENE1: false, GENE2: true });

  // Two runs at once each read and own their own entries of a gene.
  const shared = createDataLayer({ pointCount, geneCount: 3, latency: 1 });
  const first = new StreamingGeneLoader({ dataLayer: shared, tuner: fixedTuner(3) });
  const second = new StreamingGeneLoader({ dataLayer: shared, tuner: fixedTuner(3) });
  const firstItems = [];
  const secondItems = [];
  await Promise.all([
    (async () => { for await (const item of first.streamGenesRaw(genes)) firstItems.push(item); })(),
    (async () => { for await (const item of second.streamGenesRaw(genes)) secondItems.push(item); })(),
  ]);
  assert.deepEqual(firstItems.map(item => item.owned), [true, true, true]);
  assert.deepEqual(secondItems.map(item => item.owned), [true, true, true]);
  firstItems.forEach((item, i) => assert.notEqual(item.values.indices, secondItems[i].values.indices));
});
