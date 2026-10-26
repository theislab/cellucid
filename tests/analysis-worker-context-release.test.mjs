/**
 * A run that leaves state in the analysis workers releases it however the
 * run ends. A UCell signature run keeps each worker's ranks of its range of
 * cells (about 18 bytes a cell per set gene: 1.8 GB at 2M cells and 50
 * genes); the context was released only by UCELL_FINISH, so a run that was
 * cancelled, superseded or failed before it left that memory in every worker
 * until the next UCell run. And a context broadcast that is cancelled while
 * in flight leaves the context in the workers that already took it, so its
 * clear is owed from the moment the broadcast is sent (DE, pseudobulk DE, the
 * dot plot: the broadcast sits inside the try whose finally clears it).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { getWorkerPool } from '../assets/js/app/analysis/compute/worker-pool.js';
import { MultiVariableAnalysis } from '../assets/js/app/analysis/stats/multi-variable-analysis.js';

async function withPatchedWorkerPool(overrides, callback) {
  const pool = getWorkerPool();
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, Object.getOwnPropertyDescriptor(pool, key));
    Object.defineProperty(pool, key, { configurable: true, writable: true, value });
  }
  try {
    return await callback(pool);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor === undefined) delete pool[key];
      else Object.defineProperty(pool, key, descriptor);
    }
  }
}

function ucellRun() {
  const pointCount = 6;
  const dataLayer = {
    state: { pointCount },
    getAvailableVariables: () => [{ key: 'A' }, { key: 'B' }],
    async readGeneColumns(genes) {
      return genes.map(() => new Float32Array(pointCount).fill(1));
    },
  };
  return {
    analysis: new MultiVariableAnalysis(dataLayer),
    args: {
      sets: [{ name: 'set', genes: ['A', 'B'] }],
      pages: [{ pageId: 'p', pageName: 'P', cellIndices: Uint32Array.of(0, 1, 2) }],
      maxRank: 10,
      job: null,
      registerInvalidationCleanup: () => {},
    },
  };
}

test('a UCell run superseded after its contexts are set releases them in every worker', async () => {
  const { analysis, args } = ucellRun();
  const sent = [];
  let current = true;
  await withPatchedWorkerPool({
    async init() { return true; },
    getStats() { return { poolSize: 2 }; },
    async executeOnWorker(worker, type) {
      sent.push(`${type}@${worker}`);
      // Another run (or dataset) supersedes this one once its contexts are set.
      if (type === 'UCELL_SET_CONTEXT') current = false;
      return { cells: 3 };
    },
  }, async () => {
    const result = await analysis._ucellScores({ ...args, isCurrent: () => current });
    assert.equal(result, null);
  });
  assert.deepEqual(sent, [
    'UCELL_SET_CONTEXT@0', 'UCELL_SET_CONTEXT@1',
    'UCELL_CLEAR@0', 'UCELL_CLEAR@1',
  ]);
});

test('a UCell run that fails releases the contexts it set', async () => {
  const { analysis, args } = ucellRun();
  const sent = [];
  const failure = new Error('worker exploded');
  await withPatchedWorkerPool({
    async init() { return true; },
    getStats() { return { poolSize: 2 }; },
    async executeOnWorker(worker, type) {
      sent.push(`${type}@${worker}`);
      if (type === 'UCELL_SET_CONTEXT' && worker === 1) throw failure;
      return { cells: 3 };
    },
  }, async () => {
    await assert.rejects(analysis._ucellScores({ ...args, isCurrent: () => true }), error => error === failure);
  });
  assert.deepEqual(sent.filter(item => item.startsWith('UCELL_CLEAR')), ['UCELL_CLEAR@0', 'UCELL_CLEAR@1']);
});

test('the worker answers UCELL_CLEAR and MARKERS_CLEAR_CONTEXT by dropping its context', () => {
  const source = readFileSync(new URL('../assets/js/app/analysis/compute/data-worker.js', import.meta.url), 'utf8');
  assert.match(source, /case 'UCELL_CLEAR': \{\s*const released = ucellContext !== null;\s*ucellContext = null;/);
  assert.match(source, /case 'MARKERS_CLEAR_CONTEXT': \{\s*const released = markerContext !== null;\s*markerContext = null;/);
});

test('every context broadcast is sent inside the try whose finally clears it', () => {
  const files = [
    '../assets/js/app/analysis/stats/multi-variable-analysis.js',
    '../assets/js/app/analysis/ui/analysis-types/dotplot-ui.js',
  ];
  let checked = 0;
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const match of source.matchAll(/await computeManager\.broadcast\(\s*OperationType\.(\w+_SET_CONTEXT|SET_TWO_GROUP_CONTEXT)/g)) {
      const before = source.slice(Math.max(0, match.index - 400), match.index);
      assert.match(before, /try \{\s*$/, `${file}: ${match[1]} is sent inside its try`);
      checked++;
    }
  }
  // Differential expression by subset, by column and by sample (pseudobulk), and the dot plot.
  assert.equal(checked, 4);
});
