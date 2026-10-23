/**
 * The memory budgets are disjoint shares of one allowance derived from what
 * the browser reports, and a refused allocation lowers it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RESIDENCY_SHARES,
  estimatedDeviceMemory,
  memoryAllowanceBytes,
  recordAllocationFailure,
  resetAllocationFailures,
  residencyBudgetBytes,
} from '../assets/js/data/memory-budget.js';
import { DECODE_WORKER_BYTES, decodeWorkerCount } from '../assets/js/formats/io/decode-pool.js';
import { analysisMemoryBudgetMB } from '../assets/js/app/analysis/shared/performance-config.js';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

test('the shares divide the allowance exactly once', () => {
  const total = Object.values(RESIDENCY_SHARES).reduce((sum, share) => sum + share, 0);
  assert.equal(total, 1);
  const environment = { navigator: { deviceMemory: 8 } };
  const sum = Object.keys(RESIDENCY_SHARES).reduce((bytes, name) => bytes + residencyBudgetBytes(name, environment), 0);
  assert.ok(sum <= memoryAllowanceBytes(environment));
  assert.equal(memoryAllowanceBytes(environment), 4 * GiB, 'half the device');
});

test('the device estimate takes what the browser reports, and the heap limit past the top bucket', () => {
  assert.deepEqual(estimatedDeviceMemory({ navigator: { deviceMemory: 4 } }), { bytes: 4 * GiB, source: 'deviceMemory' });
  // A report below the top bucket names the device, whatever the heap limit.
  assert.deepEqual(
    estimatedDeviceMemory({ navigator: { deviceMemory: 4 }, performance: { memory: { jsHeapSizeLimit: 3.76e9 } } }),
    { bytes: 4 * GiB, source: 'deviceMemory' },
  );
  // The top bucket only says "at least 8 GiB": the heap limit of a 16 GiB Mac raises it.
  assert.deepEqual(
    estimatedDeviceMemory({ navigator: { deviceMemory: 8 }, performance: { memory: { jsHeapSizeLimit: 3.76e9 } } }),
    { bytes: 15.04e9, source: 'jsHeapSizeLimit' },
  );
  assert.deepEqual(
    estimatedDeviceMemory({ navigator: { deviceMemory: 8 }, performance: { memory: { jsHeapSizeLimit: 2 * GiB } } }),
    { bytes: 8 * GiB, source: 'deviceMemory' },
  );
  assert.deepEqual(
    estimatedDeviceMemory({ performance: { memory: { jsHeapSizeLimit: 2 * GiB } } }),
    { bytes: 8 * GiB, source: 'jsHeapSizeLimit' },
  );
  assert.deepEqual(estimatedDeviceMemory({}), { bytes: 8 * GiB, source: 'unreported' });
});

test('budgets are shares only: no floor and no ceiling of their own', () => {
  assert.equal(residencyBudgetBytes('positions', { navigator: { deviceMemory: 2 } }), 128 * MiB);
  assert.equal(residencyBudgetBytes('columnIndex', { performance: { memory: { jsHeapSizeLimit: 16 * GiB } } }), 12 * GiB);
  assert.throws(() => residencyBudgetBytes('unknown'), /Unknown residency budget/);
});

test('a refused allocation smaller than the allowance halves it; a larger one says nothing', t => {
  t.after(resetAllocationFailures);
  const environment = { navigator: { deviceMemory: 8 } };
  assert.equal(recordAllocationFailure(8 * GiB, environment), false);
  assert.equal(memoryAllowanceBytes(environment), 4 * GiB);
  assert.equal(recordAllocationFailure(512 * MiB, environment), true);
  assert.equal(memoryAllowanceBytes(environment), 2 * GiB);
  assert.equal(residencyBudgetBytes('inactiveFields', environment), 256 * MiB);
  resetAllocationFailures();
  assert.equal(memoryAllowanceBytes(environment), 4 * GiB);
});

test('the analysis default and the decode pool read their own shares', () => {
  assert.equal(analysisMemoryBudgetMB({ navigator: { deviceMemory: 8 } }), 512);
  assert.equal(analysisMemoryBudgetMB({}), 512);
  const cores = cores => ({ navigator: { hardwareConcurrency: cores } });
  // Cores less the page and the reader thread, as many as the memory holds.
  assert.equal(decodeWorkerCount(Infinity, cores(10)), 8);
  assert.equal(decodeWorkerCount(128 * MiB, cores(10)), 3);
  assert.equal(decodeWorkerCount(DECODE_WORKER_BYTES - 1, cores(10)), 0);
  assert.equal(decodeWorkerCount(Infinity, cores(2)), 1);
  assert.equal(decodeWorkerCount(Infinity, {}), 2);
});
