/**
 * What the analysis engine's gene stream (`shared/gene-stream-runner.js`)
 * must keep true no matter how it is tuned for speed:
 *
 * 1. Set identity. The values a comparison sees are exactly the cells that were
 *    selected, in cell-index order, and nothing else. The read-ahead the run
 *    tuner chooses is allowed to change *when* a gene arrives; it is never
 *    allowed to change *which cells* it contributes.
 * 2. The read-ahead is the tuner's: the stream keeps exactly as many tasks'
 *    genes in flight as the tuner says, and tells it about every read.
 *    (How the tuner sizes it, inside the memory budget, is
 *    `analysis-run-tuner-contract.test.mjs`.)
 * 3. Over a gene route the genes never reach this thread: each task's genes
 *    are delivered to the worker its task runs on, a gene only this thread
 *    holds is read here, and a task whose worker was replaced before its
 *    genes arrived has them read again (`gene-delivery-contract.test.mjs`
 *    covers the reader and the worker ends).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { runGeneStream } from '../assets/js/app/analysis/shared/gene-stream-runner.js';
import { twoGroupSubset } from '../assets/js/app/analysis/stats/multi-variable-analysis.js';
import {
  createTwoGroupContext,
  splitTwoGroups
} from '../assets/js/app/analysis/compute/gene-statistics.js';

/** A tuner that reads `depth` tasks ahead, `perTask` genes a task, and records what it is told. */
function fixedTuner(depth, perTask = 1, inFlight = 4) {
  const reads = [];
  return {
    reads,
    tasks: 0,
    pressure: 0,
    genesPerTask: () => perTask,
    prefetchDepth: () => depth,
    computeInFlight: () => inFlight,
    observeRead(read) { reads.push(read); },
    setReadsPending() {},
    taskStarted() { this.tasks++; },
    observeTask() {},
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
 * holds it): then it is the shared dense array. Genes in `delivers` (and
 * only they) can be delivered over a gene route; a delivery is recorded,
 * never answered with values.
 */
function createDataLayer({ pointCount, geneCount, latency = null, shown = new Set(), delivers = null }) {
  let concurrent = 0;
  let peakConcurrent = 0;
  const values = new Map();
  const deliveries = [];
  const readHere = [];
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
  const wait = () => (latency !== null ? new Promise(resolve => setTimeout(resolve, latency)) : Promise.resolve());
  return {
    state: { pointCount },
    values,
    deliveries,
    readHere,
    getPeakConcurrent: () => peakConcurrent,
    isGeneDeliverable: gene => delivers !== null && delivers.has(gene),
    async deliverGeneColumns(genes, delivery, options) {
      assert.equal(options.priority, 'bulk');
      assert.ok(options.signal instanceof AbortSignal);
      for (const gene of genes) assert.ok(delivers.has(gene), `${gene} is deliverable`);
      deliveries.push({ genes: [...genes], delivery });
      await wait();
      return { bytes: genes.map(() => 8 * pointCount) };
    },
    async readGeneColumn(gene, options) {
      assert.equal(options.priority, 'bulk');
      assert.ok(options.signal instanceof AbortSignal);
      readHere.push(gene);
      concurrent++;
      if (concurrent > peakConcurrent) peakConcurrent = concurrent;
      try {
        await wait();
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

/** Run a stream with no route, collecting every gene's values by its index. */
async function streamHere(dataLayer, genes, tuner, options = {}) {
  const seen = new Map();
  const completed = await runGeneStream({
    dataLayer,
    genes,
    tuner,
    route: null,
    dispatch: async task => {
      assert.equal(task.worker, null);
      assert.equal(task.delivery, null);
      return task.columns;
    },
    onResult: (task, columns) => {
      task.indices.forEach((index, k) => {
        assert.equal(task.genes[k], genes[index], 'a task names its genes by their run positions');
        seen.set(index, columns[k]);
      });
    },
    ...options,
  });
  return { completed, seen };
}

test('a stream sees exactly the selected cells of every gene, in cell-index order', async () => {
  const pointCount = 5000;
  const geneCount = 12;
  const dataLayer = createDataLayer({ pointCount, geneCount });
  const groupAIndices = sortedUniqueIndices(pointCount, 700, 3);
  const remaining = [];
  const inA = new Uint8Array(pointCount);
  for (const index of groupAIndices) inA[index] = 1;
  for (let index = 0; index < pointCount; index++) if (!inA[index]) remaining.push(index);
  const groupBIndices = Uint32Array.from(remaining.filter((_, i) => i % 3 === 0));

  const genes = Array.from({ length: geneCount }, (_, g) => `GENE${g}`);
  const { completed, seen } = await streamHere(dataLayer, genes, fixedTuner(5, 2));
  assert.equal(completed, true);
  assert.equal(seen.size, geneCount);
  const groupA = { isRestOf: false, cellIndices: groupAIndices };
  const groupB = { isRestOf: false, cellIndices: groupBIndices };
  for (const [index, values] of seen) {
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
  }
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
  const genes = ['GENE0', 'GENE1', 'GENE2', 'GENE3'];
  const { seen } = await streamHere(dataLayer, genes, fixedTuner(4));
  const groupA = { isRestOf: false, cellIndices: excluded };
  const groupB = { isRestOf: true, excludedCellIndices: excluded };
  for (const [index, values] of seen) {
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

test('the read-ahead and the genes per task never change the streamed set', async () => {
  const pointCount = 2000;
  const geneCount = 20;
  const selection = sortedUniqueIndices(pointCount, 400, 91);
  const other = sortedUniqueIndices(pointCount, 350, 92);
  const disjointOther = Uint32Array.from(
    Array.from(other).filter(index => !new Set(selection).has(index))
  );

  /** @type {string[]|null} */
  let reference = null;
  for (const [depth, perTask] of [[1, 1], [3, 2], [50, 7]]) {
    const dataLayer = createDataLayer({ pointCount, geneCount, latency: 1 });
    const genes = Array.from({ length: geneCount }, (_, g) => `GENE${g}`);
    const { seen } = await streamHere(dataLayer, genes, fixedTuner(depth, perTask));
    const groupA = { isRestOf: false, cellIndices: selection };
    const groupB = { isRestOf: false, cellIndices: disjointOther };
    const digest = [...seen.keys()].sort((a, b) => a - b).map(index => {
      const { valuesA, valuesB } = splitColumn(seen.get(index), groupA, groupB, pointCount);
      let sumA = 0;
      for (const value of valuesA) sumA += value;
      let sumB = 0;
      for (const value of valuesB) sumB += value;
      return `${index}:${genes[index]}:${valuesA.length}:${sumA}:${valuesB.length}:${sumB}`;
    });
    assert.equal(digest.length, geneCount);
    if (reference === null) reference = digest;
    else assert.deepEqual(digest, reference, `read-ahead ${depth} × ${perTask} changed the set`);
  }
});

test('the stream reads exactly as many tasks ahead as the tuner says, and reports every read', async () => {
  const pointCount = 4000;
  const geneCount = 60;
  for (const [depth, perTask] of [[1, 1], [7, 1], [4, 3]]) {
    const dataLayer = createDataLayer({ pointCount, geneCount, latency: 5 });
    const tuner = fixedTuner(depth, perTask, 64);
    const genes = Array.from({ length: geneCount }, (_, g) => `GENE${g}`);
    const { seen } = await streamHere(dataLayer, genes, tuner);
    assert.equal(seen.size, geneCount);
    assert.equal(dataLayer.getPeakConcurrent(), depth * perTask, `read-ahead ${depth} × ${perTask} is filled and never exceeded`);
    assert.equal(tuner.reads.length, geneCount / perTask, 'every task\'s read is reported to the tuner');
    for (const read of tuner.reads) {
      assert.equal(read.genes, perTask);
      assert.ok(read.bytes > 0 && read.ms >= 0, 'a read is reported with its bytes, genes and time');
    }
    assert.equal(tuner.tasks, geneCount / perTask, 'one task a batch of genes');
  }
});

test('an aborted stream starts no further reads and settles every read and task', async () => {
  const pointCount = 4000;
  const geneCount = 60;
  const dataLayer = createDataLayer({ pointCount, geneCount, latency: 5 });
  const controller = new AbortController();
  const genes = Array.from({ length: geneCount }, (_, g) => `GENE${g}`);
  let done = 0;
  let readsAtAbort = null;
  await assert.rejects(runGeneStream({
    dataLayer,
    genes,
    tuner: fixedTuner(8),
    route: null,
    signal: controller.signal,
    dispatch: async task => task.columns,
    onResult: () => {
      done++;
      if (done === 4) {
        readsAtAbort = dataLayer.readHere.length;
        controller.abort(new DOMException('test abort', 'AbortError'));
      }
    },
  }), /abort/i);
  assert.ok(done >= 4 && done < geneCount, `aborted after ${done} of ${geneCount}`);
  assert.equal(dataLayer.readHere.length, readsAtAbort, 'no read starts after the abort');
});

test('a stopped request ends its stream at once, without an error', async () => {
  const dataLayer = createDataLayer({ pointCount: 100, geneCount: 30, latency: 5 });
  const stop = new AbortController();
  const genes = Array.from({ length: 30 }, (_, g) => `GENE${g}`);
  let done = 0;
  const completed = await runGeneStream({
    dataLayer,
    genes,
    tuner: fixedTuner(4),
    route: null,
    stop: stop.signal,
    dispatch: async task => task.columns,
    onResult: () => {
      if (++done === 3) stop.abort();
    },
  });
  assert.equal(completed, false);
  assert.ok(done < 30);
});

test('a gene a view holds is copied for its task; a gene read for the run moves', async () => {
  const pointCount = 64;
  const genes = ['GENE0', 'GENE1', 'GENE2'];
  // GENE1 is loaded for a view: its task gets a copy, never the shared array.
  const dataLayer = createDataLayer({ pointCount, geneCount: 3, shown: new Set(['GENE1']) });
  const { seen } = await streamHere(dataLayer, genes, fixedTuner(3));
  const shared = dataLayer.values.get('GENE1');
  assert.ok(seen.get(1) instanceof Float32Array);
  assert.notEqual(seen.get(1), shared);
  assert.deepEqual([...seen.get(1)], [...shared]);
  assert.ok(seen.get(0).indices instanceof Uint32Array);
});

/** A route stand-in: two workers, fewest genes outstanding first. */
function fakeRoute(workers = 2) {
  const outstanding = new Array(workers).fill(0);
  const generations = new Array(workers).fill(0);
  let next = 0;
  return {
    id: 'gene-route-test',
    workerCount: workers,
    outstanding,
    generations: () => generations.slice(),
    generation: worker => generations[worker],
    bump(worker) { generations[worker]++; },
    nextDeliveryId: () => next++,
    assign(genes) {
      let best = 0;
      for (let worker = 1; worker < workers; worker++) if (outstanding[worker] < outstanding[best]) best = worker;
      outstanding[best] += genes;
      return best;
    },
    settle(worker, genes) { outstanding[worker] -= genes; },
  };
}

test('over a route, a task\'s genes go to its worker and never here; a gene only this thread holds is read here', async () => {
  const pointCount = 32;
  const genes = Array.from({ length: 9 }, (_, g) => `GENE${g}`);
  // GENE4 is a user-defined copy: only this thread holds it.
  const delivers = new Set(genes.filter(gene => gene !== 'GENE4'));
  const dataLayer = createDataLayer({ pointCount, geneCount: 9, delivers });
  const route = fakeRoute();
  const tasks = [];
  const completed = await runGeneStream({
    dataLayer,
    genes,
    tuner: fixedTuner(10, 3),
    route,
    owner: 'job-1',
    dispatch: async task => {
      tasks.push(task);
      return { ok: task.indices.length };
    },
    onResult: () => {},
  });
  assert.equal(completed, true);
  assert.deepEqual(dataLayer.readHere, ['GENE4'], 'only the gene this thread holds is read here');
  const delivered = tasks.filter(task => task.delivery !== null);
  assert.deepEqual(delivered.flatMap(task => task.genes).sort(), [...delivers].sort());
  for (const task of delivered) {
    assert.equal(task.columns, null, 'a delivered task carries no values');
    assert.ok(task.genes.length <= 3, 'a task takes the tuner\'s genes');
    const request = dataLayer.deliveries.find(entry => entry.delivery.runs.some(run => run.id === task.delivery.id));
    const run = request.delivery.runs.find(entry => entry.id === task.delivery.id);
    assert.deepEqual(request.genes.slice(run.first, run.last), task.genes);
    assert.equal(run.worker, task.worker, 'the genes go to the worker the task runs on');
    assert.deepEqual(task.delivery, { route: route.id, id: run.id, generation: 0 });
  }
  // One read serves a task on each worker.
  assert.ok(dataLayer.deliveries.every(entry => entry.delivery.runs.length <= 2));
  assert.ok(dataLayer.deliveries.some(entry => entry.delivery.runs.length === 2));
  assert.deepEqual(new Set(delivered.map(task => task.worker)), new Set([0, 1]), 'both workers are given genes');
  const here = tasks.find(task => task.delivery === null);
  assert.deepEqual(here.genes, ['GENE4']);
  assert.equal(here.worker, null);
  assert.deepEqual(route.outstanding, [0, 0], 'every delivered gene is settled');
});

test('a task whose worker was replaced before its genes arrived has them delivered again', async () => {
  const genes = ['GENE0', 'GENE1', 'GENE2', 'GENE3'];
  const dataLayer = createDataLayer({ pointCount: 16, geneCount: 4, delivers: new Set(genes) });
  const route = fakeRoute();
  const answered = new Map();
  let lostOnce = false;
  await runGeneStream({
    dataLayer,
    genes,
    tuner: fixedTuner(4, 2),
    route,
    dispatch: async task => {
      if (!lostOnce && task.worker === 0) {
        lostOnce = true;
        route.bump(0);
        return { lost: true };
      }
      return { ok: true };
    },
    onResult: task => task.genes.forEach(gene => answered.set(gene, (answered.get(gene) ?? 0) + 1)),
  });
  assert.equal(lostOnce, true);
  assert.deepEqual([...answered.keys()].sort(), genes, 'every gene is answered');
  assert.ok([...answered.values()].every(count => count === 1), 'each once');
  assert.equal(dataLayer.deliveries.length, 2, 'the lost task\'s genes are delivered again');
  assert.deepEqual(dataLayer.deliveries[1].genes, dataLayer.deliveries[0].genes.slice(0, 2), 'only the lost task\'s');
});

test('a split stream delivers each task\'s genes to every worker, each its range of cells', async () => {
  const genes = ['GENE0', 'GENE1', 'GENE2'];
  const dataLayer = createDataLayer({ pointCount: 10, geneCount: 3, delivers: new Set(genes) });
  const route = fakeRoute();
  const split = Uint32Array.of(0, 5, 10);
  const tasks = [];
  await runGeneStream({
    dataLayer,
    genes,
    tuner: fixedTuner(2, 3),
    route,
    split,
    dispatch: async task => {
      tasks.push(task);
      return [];
    },
    onResult: () => {},
  });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].worker, null);
  assert.deepEqual(tasks[0].delivery, { route: route.id, id: 0, generations: [0, 0] });
  assert.equal(dataLayer.deliveries[0].delivery.split, split);
  assert.deepEqual(dataLayer.deliveries[0].delivery.generations, [0, 0]);
});

test('two groups are read as their union in cell order, each position labelled with its group', () => {
  const pointCount = 3000;
  const groupAIndices = sortedUniqueIndices(pointCount, 40, 11);
  const inA = new Set(groupAIndices);
  const groupBIndices = Uint32Array.from(
    [...sortedUniqueIndices(pointCount, 60, 12)].filter(cell => !inA.has(cell))
  );
  const { cells, groupOfPosition } = twoGroupSubset(groupAIndices, groupBIndices);
  assert.deepEqual([...cells], [...cells].sort((a, b) => a - b), 'the cells are read in cell order');
  assert.equal(cells.length, groupAIndices.length + groupBIndices.length);
  for (let position = 0; position < cells.length; position++) {
    assert.equal(groupOfPosition[position], inA.has(cells[position]) ? 1 : 2);
  }
  assert.throws(() => twoGroupSubset(Uint32Array.of(1, 2), Uint32Array.of(2, 3)), /both groups/);
});
