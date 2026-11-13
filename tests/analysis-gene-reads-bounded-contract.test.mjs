/**
 * An analysis that reads many genes holds no more of them at once than the
 * one memory model gives it (`data/memory-budget.js`, the `analysis` share),
 * and every byte it holds is counted there:
 *
 * 1. Two groups read in their cells (differential expression,
 *    `runGeneStream`'s `cells`) are read a block of genes at a time: a read
 *    takes as many genes as the memory gate holds (`bufferedTasks`), never
 *    every gene of the run in one request unless they all fit. Read by cell,
 *    each read decodes the cells' rows whatever its genes, so when all the
 *    genes fit they are read once.
 * 2. The genes a run has read and not yet computed are counted in the
 *    `analysis` share while it goes (`GENES_IN_FLIGHT_LABEL`), and given back
 *    when it ends, however it ends.
 * 3. Differential expression gives the same numbers, bit for bit, whether
 *    its genes come in one block or in many, and whether its groups are read
 *    in their cells or as whole columns.
 * 4. Signature scores read each set's genes (and controls) a batch at a time
 *    on this thread (`visitGeneColumnsHere`), with the same scores; UCell's
 *    per-cell state in the workers is counted, and scored a part of the
 *    cells at a time when it does not all fit, with the same scores.
 * 5. No analysis module reads a cell subset, or genes' columns all at once,
 *    except through the gene stream (a source scan).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { GENES_IN_FLIGHT_LABEL, createRunTunerFor, runGeneStream } from '../assets/js/app/analysis/shared/gene-stream-runner.js';
import { createRunTuner } from '../assets/js/app/analysis/shared/run-tuner.js';
import { CELL_SUBSET_ENTRY_BYTES } from '../assets/js/data/gene-delivery.js';
import {
  memoryAllowanceBytes,
  memoryReport,
  resetMemoryModel,
  residencyBudgetBytes,
  setWorkingSet,
} from '../assets/js/data/memory-budget.js';
import { MultiVariableAnalysis } from '../assets/js/app/analysis/stats/multi-variable-analysis.js';
import { getWorkerPool } from '../assets/js/app/analysis/compute/worker-pool.js';
import { createUcellContext, ucellAddGenes, ucellContextBytesPerCell, ucellFinish, ucellSetValues } from '../assets/js/app/analysis/compute/ucell.js';
import {
  clearTwoGroupContext,
  computeDifferentialOfColumns,
  computeDifferentialOfSubset,
  setTwoGroupContext,
} from '../assets/js/app/analysis/compute/operation-handlers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Dense gene columns over `pointCount` cells, about a third non-zero, with ties. */
function makeColumns(pointCount, geneCount, seed) {
  const random = mulberry32(seed);
  const columns = new Map();
  for (let g = 0; g < geneCount; g++) {
    const column = new Float32Array(pointCount);
    for (let cell = 0; cell < pointCount; cell++) {
      if (random() < 0.35) column[cell] = Math.round(random() * 8 * (1 + (g % 3))) / 4;
    }
    columns.set(`GENE${g}`, column);
  }
  return columns;
}

/** The block `readGeneCellSubset` reads: each gene's non-zero entries in `cells`, positions into them. */
function blockOf(columns, keys, cells) {
  const pointers = new Float64Array(keys.length + 1);
  const positions = [];
  const values = [];
  keys.forEach((key, g) => {
    const column = columns.get(key);
    cells.forEach((cell, position) => {
      if (column[cell] !== 0) {
        positions.push(position);
        values.push(column[cell]);
      }
    });
    pointers[g + 1] = positions.length;
  });
  return { pointers, cellIndex: Int32Array.from(positions), values: Float32Array.from(values) };
}

/**
 * A data layer whose genes are read from `columns`: in some cells (here, as a
 * block) or whole; every read recorded with how many genes it asked for.
 */
function stubDataLayer(columns, pointCount, { subsets = true } = {}) {
  const reads = [];
  const layer = {
    state: { pointCount },
    reads,
    resolveExpressionMatrix: () => ({ matrix: 'X', read: null, label: 'Mapped (X)' }),
    // Genes are read for every open cell (no gene sample).
    geneCellsOf: async () => null,
    matrixHoldsCounts: () => false,
    expressionTransformOf: () => ({ normalize: false, log1p: false }),
    runValues: async () => ({ transform: { normalize: false, log1p: false }, sizes: null, key: 'raw', record: null }),
    async getGeneKeys() { return [...columns.keys()]; },
    getAvailableVariables: () => [...columns.keys()].map(key => ({ key })),
    isGeneDeliverable: gene => columns.has(gene),
    async readGeneColumn(gene) {
      reads.push({ kind: 'column', genes: 1 });
      return { fieldIndex: 0, values: columns.get(gene), owned: false };
    },
  };
  if (subsets) {
    layer.readsGeneCellSubsets = () => true;
    layer.readGeneCellSubset = async (keys, cells, options) => {
      assert.ok(options.signal instanceof AbortSignal, 'a subset read can be stopped');
      reads.push({ kind: 'subset', genes: keys.length });
      return blockOf(columns, keys, cells);
    };
  }
  return layer;
}

/** A compute manager computing on this thread, as the app's `cpu` backend does. */
function cpuComputeManager() {
  return {
    selectBackend: () => 'cpu',
    async broadcast(operation, payloadFor) {
      if (operation === 'SET_TWO_GROUP_CONTEXT') return [setTwoGroupContext(payloadFor(0))];
      if (operation === 'CLEAR_TWO_GROUP_CONTEXT') return [clearTwoGroupContext(payloadFor(0))];
      throw new Error(`Unexpected broadcast ${operation}`);
    },
    async execute(operation, payload) {
      if (operation === 'COMPUTE_DIFFERENTIAL_OF_SUBSET') return computeDifferentialOfSubset(payload);
      if (operation === 'COMPUTE_DIFFERENTIAL_OF_COLUMNS') return computeDifferentialOfColumns(payload);
      throw new Error(`Unexpected operation ${operation}`);
    },
  };
}

/** Hold the `analysis` share to about `bytes`: the working set takes the rest of the allowance. */
function holdAnalysisShareTo(t, bytes) {
  resetMemoryModel();
  setWorkingSet('test', Math.max(0, memoryAllowanceBytes() - bytes * 16));
  t.after(resetMemoryModel);
  return residencyBudgetBytes('analysis');
}

async function runDifferential(layer, groupA, groupB, method) {
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = layer;
  analysis._getComputeManager = async () => cpuComputeManager();
  const result = await analysis.differentialExpression({
    groupA: { name: 'A', cells: groupA },
    groupB: { name: 'B', cells: groupB },
    method,
    minCells: 2,
  });
  return result.results.map(row => [row.gene, row.meanA, row.meanB, row.pctA, row.pctB, row.log2FoldChange,
    row.pValue, row.adjustedPValue, row.statistic, row.score, row.auroc, row.nA, row.nB]);
}

function groupsOf(pointCount, seed) {
  const random = mulberry32(seed);
  const a = [];
  const b = [];
  for (let cell = 0; cell < pointCount; cell++) {
    const r = random();
    if (r < 0.3) a.push(cell);
    else if (r < 0.55) b.push(cell);
  }
  return { a: Uint32Array.from(a), b: Uint32Array.from(b) };
}

test('a run over some cells reads as many genes as the memory gate holds, never every gene unless they fit', async t => {
  const pointCount = 400;
  const geneCount = 60;
  const columns = makeColumns(pointCount, geneCount, 1);
  const cells = Uint32Array.from({ length: 200 }, (_, k) => 2 * k);
  const layer = stubDataLayer(columns, pointCount);
  // A budget whose buffered share holds a few genes' blocks at most.
  const blockBytes = cells.length * CELL_SUBSET_ENTRY_BYTES;
  const budget = Math.floor((blockBytes * 4) / 0.3);
  const tuner = createRunTuner({ poolSize: 2, cellCount: cells.length, bytesPerCell: CELL_SUBSET_ENTRY_BYTES, budgetBytes: () => budget });
  const gates = [];
  const seen = new Set();
  const completed = await runGeneStream({
    dataLayer: { ...layer, readGeneCellSubset: async (keys, at, options) => {
      gates.push({ genes: keys.length, gate: tuner.bufferedTasks() * tuner.genesPerTask() });
      return layer.readGeneCellSubset(keys, at, options);
    } },
    genes: [...columns.keys()],
    tuner,
    route: null,
    cells,
    dispatch: async task => {
      assert.ok(task.block !== null && task.columns === null, 'a task over some cells carries its block');
      return task.genes;
    },
    onResult: task => task.genes.forEach(gene => seen.add(gene)),
  });
  assert.equal(completed, true);
  assert.equal(seen.size, geneCount, 'every gene is computed once');
  assert.ok(gates.length > 1, 'the genes are read in more than one request');
  for (const { genes, gate } of gates) {
    assert.ok(genes < geneCount, 'no request reads every gene of the run');
    assert.ok(genes <= gate, `a read of ${genes} genes stays within the gate (${gate})`);
  }

  // A budget that holds every gene: one read (the rows are decoded once).
  const roomy = createRunTunerFor(layer, 2, geneCount, { cells });
  const readsBefore = layer.reads.length;
  await runGeneStream({
    dataLayer: layer,
    genes: [...columns.keys()],
    tuner: roomy,
    route: null,
    cells,
    dispatch: async () => [],
    onResult: () => {},
  });
  assert.deepEqual(layer.reads.slice(readsBefore).map(read => read.genes), [geneCount]);
});

test('over a route, a run over some cells delivers each read\'s blocks to the workers, a read the gate holds', async () => {
  const geneCount = 24;
  const cells = Uint32Array.from({ length: 50 }, (_, k) => k);
  const requests = [];
  const outstanding = [0, 0];
  let nextId = 0;
  const route = {
    id: 'route-1',
    workerCount: 2,
    assign(genes) {
      const worker = outstanding[0] <= outstanding[1] ? 0 : 1;
      outstanding[worker] += genes;
      return worker;
    },
    settle(worker, genes) { outstanding[worker] -= genes; },
    generation: () => 0,
    generations: () => [0, 0],
    nextDeliveryId: () => nextId++,
  };
  const genes = Array.from({ length: geneCount }, (_, g) => `GENE${g}`);
  const layer = {
    state: { pointCount: 100 },
    isGeneDeliverable: () => true,
    async deliverGeneCellSubset(keys, at, delivery, options) {
      assert.equal(at, cells, 'the run\'s cells are read');
      assert.ok(options.signal instanceof AbortSignal);
      requests.push({ genes: keys.length, runs: delivery.runs.length });
      return { bytes: keys.length * 100 };
    },
    async deliverGeneColumns() { throw new Error('a run over some cells reads blocks, not columns'); },
  };
  // 100 B a gene, a budget whose buffered share holds 6 genes.
  const tuner = createRunTuner({ poolSize: 2, cellCount: cells.length, bytesPerCell: CELL_SUBSET_ENTRY_BYTES, budgetBytes: () => 2000 });
  tuner.observeRead({ bytes: 100, ms: 1 });
  const tasks = [];
  await runGeneStream({
    dataLayer: layer,
    genes,
    tuner,
    route,
    cells,
    dispatch: async task => { tasks.push(task); return { ok: true }; },
    onResult: () => {},
  });
  assert.equal(requests.reduce((sum, request) => sum + request.genes, 0), geneCount);
  assert.ok(requests.length > 1 && requests.every(request => request.genes <= 6), JSON.stringify(requests));
  assert.ok(tasks.every(task => task.delivery !== null && task.block === null && task.columns === null));
  assert.deepEqual(outstanding, [0, 0], 'every delivered gene is settled');
});

test('a run over some cells reads half the gate at a time, never a read a task', async () => {
  // A read over some cells costs its cells whatever its genes; started as
  // each task left the gate, a differential expression of millions of cells
  // would make a read every task (measured: 23_decisions_partial_reading.md).
  const geneCount = 400;
  const cells = Uint32Array.from({ length: 50 }, (_, k) => k);
  const requests = [];
  let nextId = 0;
  const route = {
    id: 'route-1',
    workerCount: 2,
    assign: () => 0,
    settle() {},
    generation: () => 0,
    generations: () => [0, 0],
    nextDeliveryId: () => nextId++,
  };
  const genes = Array.from({ length: geneCount }, (_, g) => `GENE${g}`);
  const layer = {
    state: { pointCount: 100 },
    isGeneDeliverable: () => true,
    async deliverGeneCellSubset(keys) {
      requests.push(keys.length);
      return { bytes: keys.length * 100 };
    },
    async deliverGeneColumns() { throw new Error('a run over some cells reads blocks, not columns'); },
  };
  // 100 B a gene, a gate of 60 genes (one a task).
  const tuner = createRunTuner({ poolSize: 2, cellCount: cells.length, bytesPerCell: CELL_SUBSET_ENTRY_BYTES, budgetBytes: () => 20000 });
  tuner.observeRead({ bytes: 100, ms: 1 });
  const gate = tuner.bufferedTasks() * tuner.genesPerTask();
  await runGeneStream({
    dataLayer: layer,
    genes,
    tuner,
    route,
    cells,
    dispatch: async () => ({ ok: true }),
    onResult: () => {},
  });
  assert.equal(requests.reduce((sum, count) => sum + count, 0), geneCount);
  const left = [...requests];
  left.pop();
  assert.ok(left.every(count => count >= gate / 2), `reads of ${JSON.stringify(requests)} genes, the gate ${gate}`);
  assert.ok(requests.length <= Math.ceil(geneCount / (gate / 2)) + 1, `${requests.length} reads`);
});

test('genes per task follow the genes\' bytes as read: a sparse run is a few large tasks, not a task a gene', async t => {
  // Held at each gene's densest form (8 B a cell) against what the run's
  // context leaves of the share, a differential expression over millions of
  // cells would go one gene a task: tens of thousands of tasks, reads and page
  // messages where the pushed tree sends a few hundred
  // (measured: 23_decisions_partial_reading.md).
  const budget = holdAnalysisShareTo(t, 400 * 2 ** 20);
  const geneCount = 30_000;
  const poolSize = 8;
  const cells = new Uint32Array(1_900_000);
  for (let k = 0; k < cells.length; k++) cells[k] = 5 * k;
  // A gene holds 50,000 entries in the cells (2.6%), 8 B each, as read.
  const bytesPerGene = 50_000 * CELL_SUBSET_ENTRY_BYTES;
  let nextId = 0;
  const route = {
    id: 'route-1',
    workerCount: poolSize,
    assign: () => 0,
    settle() {},
    generation: () => 0,
    generations: () => [0],
    nextDeliveryId: () => nextId++,
  };
  const reads = [];
  const layer = {
    state: { pointCount: 10_000_000 },
    isGeneDeliverable: () => true,
    async deliverGeneCellSubset(keys) {
      reads.push(keys.length);
      return { bytes: keys.length * bytesPerGene };
    },
    async deliverGeneColumns() { throw new Error('a run over some cells reads blocks, not columns'); },
  };
  const tuner = createRunTunerFor(layer, poolSize, geneCount, { cells });
  assert.equal(tuner.genesPerTask(), 1, 'unmeasured, a gene is its densest form: one a task at this budget');
  const tasks = [];
  await runGeneStream({
    dataLayer: layer,
    genes: Array.from({ length: geneCount }, (_, g) => `G${g}`),
    tuner,
    route,
    cells,
    dispatch: async task => {
      tasks.push(task.genes.length);
      return { ok: true };
    },
    onResult: () => {},
  });
  assert.equal(tasks.reduce((sum, genes) => sum + genes, 0), geneCount, 'every gene computed once');
  const even = Math.ceil(geneCount / (poolSize * 16));
  const byMemory = Math.floor((budget * 0.5) / (poolSize * 2 * bytesPerGene));
  assert.equal(tuner.genesPerTask(), Math.min(even, byMemory), 'sized at the bytes as read');
  assert.ok(tasks.length <= Math.ceil(geneCount / tuner.genesPerTask()) + 64, `${tasks.length} tasks for ${geneCount} genes`);
  // Reads: half the memory gate of genes each (as `roomToRead`), not one a task.
  const gate = tuner.bufferedTasks() * tuner.genesPerTask();
  assert.ok(reads.length <= Math.ceil(geneCount / Math.floor(gate / 2)) + 8, `${reads.length} reads, a gate of ${gate} genes`);
});

test('the genes a run reads and has not computed are counted in the analysis share, and given back when it ends', async t => {
  holdAnalysisShareTo(t, 64 * 2 ** 20);
  const pointCount = 300;
  const columns = makeColumns(pointCount, 12, 2);
  const cells = Uint32Array.from({ length: 150 }, (_, k) => k);
  const layer = stubDataLayer(columns, pointCount);
  const tuner = createRunTunerFor(layer, 1, 12, { cells });
  const counted = () => memoryReport().shares.analysis.heldBytes;
  assert.equal(counted(), 0);
  const during = [];
  await runGeneStream({
    dataLayer: layer,
    genes: [...columns.keys()],
    tuner,
    route: null,
    cells,
    dispatch: async task => {
      during.push(counted());
      // The task's own genes are among those counted.
      assert.ok(counted() >= tuner.taskBytes(), 'a task in flight is counted');
      return task.genes;
    },
    onResult: () => {},
  });
  assert.ok(during.length > 0 && during.every(bytes => bytes > 0));
  assert.equal(counted(), 0, 'nothing is counted once the run ended');

  // A run that fails gives its count back too.
  await assert.rejects(runGeneStream({
    dataLayer: layer,
    genes: [...columns.keys()],
    tuner: createRunTunerFor(layer, 1, 12, { cells }),
    route: null,
    cells,
    dispatch: async () => { throw new Error('worker failed'); },
    onResult: () => {},
  }), /worker failed/);
  assert.equal(counted(), 0);
  assert.equal(GENES_IN_FLIGHT_LABEL, 'analysis genes in flight');
});

test('differential expression gives the same numbers from one block, many blocks, or whole columns', async t => {
  const pointCount = 900;
  const geneCount = 40;
  const columns = makeColumns(pointCount, geneCount, 3);
  const { a, b } = groupsOf(pointCount, 4);
  for (const method of ['wilcox', 'ttest', 'ttest_overestim_var']) {
    // Roomy: every gene in one block.
    resetMemoryModel();
    const roomyLayer = stubDataLayer(columns, pointCount);
    const roomy = await runDifferential(roomyLayer, a, b, method);
    assert.deepEqual(roomyLayer.reads.map(read => read.genes), [geneCount], `${method}: one block when every gene fits`);

    // Tight: the analysis share holds a few genes' blocks.
    const blockBytes = (a.length + b.length) * CELL_SUBSET_ENTRY_BYTES;
    holdAnalysisShareTo(t, blockBytes * 6);
    const tightLayer = stubDataLayer(columns, pointCount);
    const tight = await runDifferential(tightLayer, a, b, method);
    assert.ok(tightLayer.reads.length > 1, `${method}: many blocks when few fit`);
    assert.ok(tightLayer.reads.every(read => read.kind === 'subset' && read.genes < geneCount));
    assert.deepEqual(tight, roomy, `${method}: the same numbers from many blocks`);

    // Whole columns (a source that cannot read cell subsets).
    resetMemoryModel();
    const wholeLayer = stubDataLayer(columns, pointCount, { subsets: false });
    const whole = await runDifferential(wholeLayer, a, b, method);
    assert.ok(wholeLayer.reads.every(read => read.kind === 'column'));
    assert.deepEqual(whole, roomy, `${method}: the same numbers from whole columns`);
    assert.equal(memoryReport().shares.analysis.heldBytes, 0, `${method}: nothing held after the run`);
  }
});

/** A signature run on `columns` (two pages), every read's genes recorded. */
async function runSignature(columns, pointCount, method, geneSets) {
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  const reads = [];
  const half = Math.floor(pointCount / 2);
  analysis.dataLayer = {
    state: { pointCount },
    getAvailableVariables: type => (type === 'gene_expression' ? [...columns.keys()].map(key => ({ key })) : []),
    getDatasetGeneration: () => Symbol(method),
    // Genes are read for every open cell (no gene sample).
    geneCellsOf: async () => null,
    matrixHoldsCounts: () => false,
    expressionTransformOf: () => ({ normalize: false, log1p: false }),
    runValues: async () => ({ transform: { normalize: false, log1p: false }, sizes: null, key: 'raw', record: null }),
    getPageCells: pageIds => pageIds.map((pageId, page) => ({
      pageId,
      pageName: pageId,
      cellIndices: Uint32Array.from({ length: half }, (_, k) => k * 2 + page),
    })),
    async readGeneColumns(genes) {
      reads.push(genes.length);
      return genes.map(gene => {
        const column = columns.get(gene);
        const indices = [];
        for (let cell = 0; cell < column.length; cell++) if (column[cell] !== 0) indices.push(cell);
        return { length: column.length, indices: Uint32Array.from(indices), values: Float32Array.from(indices, cell => column[cell]) };
      });
    },
  };
  analysis._computeManager = null;
  const result = await analysis.computeSignatureScore({ geneSets, pageIds: ['P0', 'P1'], method });
  return { reads, sets: result.sets.map(set => ({ genes: set.genes, constantGenes: set.constantGenes, pages: set.pages.map(page => [...page.scores]) })) };
}

test('signature scores read their genes a batch at a time and score the same, bit for bit', async t => {
  const pointCount = 2000;
  const columns = makeColumns(pointCount, 30, 5);
  // A constant gene (no z-score).
  columns.set('GENE29', new Float32Array(pointCount).fill(2));
  const geneSets = [
    { name: 'one', genes: Array.from({ length: 14 }, (_, g) => `GENE${g}`) },
    { name: 'two', genes: ['GENE29', ...Array.from({ length: 12 }, (_, g) => `GENE${28 - g}`)] },
  ];
  for (const method of ['mean', 'median', 'mean_z']) {
    resetMemoryModel();
    const roomy = await runSignature(columns, pointCount, method, geneSets);
    holdAnalysisShareTo(t, pointCount * 4 * 6);
    const tight = await runSignature(columns, pointCount, method, geneSets);
    assert.ok(Math.max(...roomy.reads) > Math.max(...tight.reads), `${method}: the tight run reads fewer genes at once`);
    assert.ok(tight.reads.every(genes => genes < 14), `${method}: no read takes a whole set`);
    assert.deepEqual(tight.sets, roomy.sets, `${method}: the same scores`);
    assert.equal(memoryReport().shares.analysis.heldBytes, 0, `${method}: nothing held after the run`);
  }
});

/** UCell signature scores through `_ucellScores`, the workers run in process (`data-worker.js`'s cases). */
async function runUcell(columns, pointCount, sets, onAdd = () => {}) {
  const pool = getWorkerPool();
  const contexts = new Map();
  const patched = {
    async init() { return true; },
    getStats() { return { poolSize: 3 }; },
    async executeOnWorker(worker, type, payload) {
      if (type === 'UCELL_SET_CONTEXT') {
        const { cellCount, setGeneCount, geneCount, sets: slots, maxRank, inline } = payload;
        const parts = inline === null ? [] : [inline];
        contexts.set(worker, createUcellContext({ cellCount, setValues: ucellSetValues(cellCount, setGeneCount, parts), setGeneCount, geneCount, sets: slots, maxRank }));
        return { cells: cellCount };
      }
      if (type === 'UCELL_ADD_GENES') {
        onAdd();
        ucellAddGenes(contexts.get(worker), payload.ranges);
        return { added: payload.ranges.pointers.length - 1 };
      }
      if (type === 'UCELL_FINISH') {
        const scores = ucellFinish(contexts.get(worker));
        contexts.delete(worker);
        return { scores };
      }
      if (type === 'UCELL_CLEAR') return { released: contexts.delete(worker) };
      throw new Error(`Unexpected ${type}`);
    },
  };
  const saved = new Map(Object.keys(patched).map(key => [key, Object.getOwnPropertyDescriptor(pool, key)]));
  for (const [key, value] of Object.entries(patched)) Object.defineProperty(pool, key, { configurable: true, writable: true, value });
  try {
    const analysis = Object.create(MultiVariableAnalysis.prototype);
    analysis.dataLayer = {
      state: { pointCount },
      getAvailableVariables: () => [...columns.keys()].map(key => ({ key })),
      async readGeneColumns(genes) { return genes.map(gene => columns.get(gene)); },
      async readGeneColumn(gene) { return { fieldIndex: 0, values: columns.get(gene), owned: false }; },
    };
    const result = await analysis._ucellScores({
      sets,
      pages: [{ pageId: 'all', pageName: 'All', cellIndices: Uint32Array.from({ length: pointCount }, (_, cell) => cell) }],
      maxRank: 8,
      job: null,
      isCurrent: () => true,
      registerInvalidationCleanup: () => {},
    });
    return result.map(set => [...set.pages[0].scores]);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) delete pool[key];
      else Object.defineProperty(pool, key, descriptor);
    }
  }
}

test('UCell scores the cells a part at a time when every cell\'s state does not fit, with the same scores', async t => {
  const pointCount = 300;
  const columns = makeColumns(pointCount, 12, 6);
  const sets = [{ name: 'a', genes: ['GENE1', 'GENE4', 'GENE7'] }, { name: 'b', genes: ['GENE2', 'GENE4'] }];
  const bytesPerCell = ucellContextBytesPerCell(4);
  resetMemoryModel();
  const whole = await runUcell(columns, pointCount, sets);
  // Half the run's budget holds about a fifth of the cells' state.
  holdAnalysisShareTo(t, Math.ceil((pointCount * bytesPerCell * 2) / 5));
  let counted = 0;
  const inParts = await runUcell(columns, pointCount, sets, () => {
    counted = Math.max(counted, memoryReport().shares.analysis.heldBytes);
  });
  assert.deepEqual(inParts, whole, 'the same scores, part by part');
  assert.ok(counted >= Math.floor(pointCount / 5) * bytesPerCell * 0.9, `the workers' state is counted while held (${counted} B)`);
  assert.ok(counted < pointCount * bytesPerCell, 'never every cell\'s state at once');
  assert.equal(memoryReport().shares.analysis.heldBytes, 0, 'nothing counted after the run');
});

function sourcesUnder(folder) {
  const out = [];
  for (const name of readdirSync(folder)) {
    const full = path.join(folder, name);
    if (statSync(full).isDirectory()) out.push(...sourcesUnder(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('analyses read cell subsets and many genes only through the gene stream', () => {
  const analysis = path.join(ROOT, 'assets/js/app/analysis');
  const allowed = new Map([
    // The stream itself, and the data layer that defines the reads.
    ['deliverGeneCellSubset(', new Set(['shared/gene-stream-runner.js', 'data/data-layer.js'])],
    ['readGeneCellSubset(', new Set(['shared/gene-stream-runner.js', 'data/data-layer.js'])],
    ['deliverGeneColumns(', new Set(['shared/gene-stream-runner.js', 'data/data-layer.js', 'stats/multi-variable-analysis.js'])],
    // Many genes' columns at once on this thread: the batched pass only.
    ['readGeneColumns(', new Set(['shared/gene-stream-runner.js', 'data/data-layer.js'])],
  ]);
  for (const file of sourcesUnder(analysis)) {
    const relative = path.relative(analysis, file).split(path.sep).join('/');
    const text = readFileSync(file, 'utf8');
    for (const [call, files] of allowed) {
      if (text.includes(`.${call}`)) {
        assert.ok(files.has(relative), `${relative} calls ${call} outside the gene stream`);
      }
    }
  }
});
