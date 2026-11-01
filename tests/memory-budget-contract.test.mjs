/**
 * The memory model (`data/memory-budget.js`): one allowance derived from what
 * the browser reports, divided between what is drawn (the working set) and
 * the caches; a ledger of what every cache keeps, trimmed whenever the
 * allowance or the working set changes, in every thread; refused
 * allocations lower the allowance and evidence raises it back.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CELL_WORKING_SET_BYTES,
  RELEASE_ORDER,
  RESIDENCY_SHARES,
  cacheRoomBytes,
  connectMemoryWorker,
  estimatedDeviceMemory,
  heldBytes,
  isDrawn,
  memoryAllowanceBytes,
  memoryReport,
  onMemoryChange,
  onMemoryReleased,
  recordAllocationFailure,
  recordAllocationSuccess,
  registerResidentHolder,
  releaseResidentMemory,
  resetMemoryModel,
  residencyBudgetBytes,
  retryRefusedAllocation,
  setOpenCells,
  setOtherInstances,
  setWorkingSet,
  settleMemory,
  typedArrayBytes,
  workingSetBytes,
} from '../assets/js/data/memory-budget.js';
import { DECODE_WORKER_BYTES, decodeWorkerCount } from '../assets/js/formats/io/decode-pool.js';

import { until } from './helpers/until.mjs';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** A cache of `bytes` entries, least recently used first. */
function cache(share, entries, label = share) {
  const kept = [...entries];
  const trims = [];
  const stop = registerResidentHolder(share, {
    label,
    bytes: () => kept.reduce((sum, bytes) => sum + bytes, 0),
    trim: budget => {
      trims.push(budget);
      let dropped = 0;
      while (kept.length > 0 && kept.reduce((sum, bytes) => sum + bytes, 0) > budget) {
        kept.shift();
        dropped++;
      }
      return dropped === 0 ? null : `${dropped} ${label}`;
    },
  });
  return { kept, trims, stop };
}

test.beforeEach(() => resetMemoryModel());
test.after(() => resetMemoryModel());

test('the shares divide what the working set leaves of the allowance exactly once, and every share has one place in the release order', () => {
  const total = Object.values(RESIDENCY_SHARES).reduce((sum, share) => sum + share, 0);
  assert.equal(total, 1);
  assert.deepEqual([...RELEASE_ORDER].sort(), Object.keys(RESIDENCY_SHARES).sort());
  const environment = { navigator: { deviceMemory: 8 } };
  assert.equal(memoryAllowanceBytes(environment), 4 * GiB, 'half the device');
  const sum = Object.keys(RESIDENCY_SHARES).reduce((bytes, name) => bytes + residencyBudgetBytes(name, environment), 0);
  assert.ok(sum <= memoryAllowanceBytes(environment));
});

test('the device estimate takes what the browser reports, and the heap limit past the top bucket', () => {
  assert.deepEqual(estimatedDeviceMemory({ navigator: { deviceMemory: 4 } }), { bytes: 4 * GiB, source: 'deviceMemory' });
  assert.deepEqual(
    estimatedDeviceMemory({ navigator: { deviceMemory: 4 }, performance: { memory: { jsHeapSizeLimit: 3.76e9 } } }),
    { bytes: 4 * GiB, source: 'deviceMemory' },
  );
  assert.deepEqual(
    estimatedDeviceMemory({ navigator: { deviceMemory: 8 }, performance: { memory: { jsHeapSizeLimit: 3.76e9 } } }),
    { bytes: 15.04e9, source: 'jsHeapSizeLimit' },
  );
  assert.deepEqual(
    estimatedDeviceMemory({ navigator: { deviceMemory: 8 }, performance: { memory: { jsHeapSizeLimit: 2 * GiB } } }),
    { bytes: 8 * GiB, source: 'deviceMemory' },
  );
  assert.deepEqual(estimatedDeviceMemory({ performance: { memory: { jsHeapSizeLimit: 2 * GiB } } }), { bytes: 8 * GiB, source: 'jsHeapSizeLimit' });
  assert.deepEqual(estimatedDeviceMemory({}), { bytes: 8 * GiB, source: 'unreported' }, 'Firefox and Safari: 8 GiB taken');
});

test('budgets are shares only: no floor and no ceiling of their own', () => {
  assert.equal(residencyBudgetBytes('positions', { navigator: { deviceMemory: 2 } }), 128 * MiB);
  assert.equal(residencyBudgetBytes('columnIndex', { performance: { memory: { jsHeapSizeLimit: 16 * GiB } } }), 12 * GiB);
  assert.throws(() => residencyBudgetBytes('unknown'), /Unknown residency budget/);
});

test('the working set and the caches divide one allowance: the open cells and a shown graph leave the caches less', () => {
  const allowance = memoryAllowanceBytes();
  assert.equal(cacheRoomBytes(), allowance);
  setOpenCells(10_000_000);
  const drawn = 10_000_000 * CELL_WORKING_SET_BYTES;
  assert.equal(memoryReport().workingSetBytes, drawn);
  assert.equal(cacheRoomBytes(), allowance - drawn);
  assert.equal(residencyBudgetBytes('columnIndex'), Math.floor((allowance - drawn) * 3 / 8));
  // A graph a view shows is drawn: counted there, and a cache keeping the
  // same object does not count it again.
  const graph = { records: new Uint8Array(1000), neighbors: new Uint32Array(250) };
  assert.equal(typedArrayBytes(graph), 2000);
  setWorkingSet('graph', typedArrayBytes(graph), graph);
  assert.equal(isDrawn(graph), true);
  assert.equal(cacheRoomBytes(), allowance - drawn - 2000);
  setWorkingSet('graph', 0);
  assert.equal(isDrawn(graph), false);
  // Every share together with the working set never exceeds the allowance.
  const caches = Object.keys(RESIDENCY_SHARES).reduce((sum, name) => sum + residencyBudgetBytes(name), 0);
  assert.ok(caches + memoryReport().workingSetBytes <= allowance);
  // A working set beyond the allowance leaves the caches nothing (they read again).
  setOpenCells(Math.ceil(allowance / CELL_WORKING_SET_BYTES) + 1);
  assert.equal(cacheRoomBytes(), 0);
  assert.equal(residencyBudgetBytes('decodedBlocks'), 0);
});

test('whenever the working set grows, every share over its new budget is trimmed, oldest holder first, cheapest share first', () => {
  const allowance = memoryAllowanceBytes();
  const order = [];
  const decoded = cache('decodedBlocks', [allowance / 32 * 0.6, allowance / 32 * 0.3]);
  const first = cache('adapterCache', [allowance / 16 * 0.5]);
  const second = cache('adapterCache', [allowance / 16 * 0.4]);
  const index = cache('columnIndex', [allowance * 3 / 8 * 0.9]);
  const stop = onMemoryReleased(({ reason, released }) => order.push(reason, ...released));
  // Nothing over its budget: nothing trimmed.
  assert.deepEqual(settleMemory(), []);
  // Half the allowance drawn: every share's budget halves.
  setOpenCells(Math.floor(allowance / 2 / CELL_WORKING_SET_BYTES));
  assert.ok(decoded.kept.length < 2, 'decoded chunks trimmed');
  assert.ok(first.kept.length === 0 && second.kept.length === 1, 'the older holder of a share gives back first');
  assert.equal(index.kept.length, 0);
  assert.equal(order[0], 'working set');
  assert.ok(order.indexOf('1 decodedBlocks') < order.indexOf('1 adapterCache'), 'cheapest to rebuild first');
  assert.ok(order.indexOf('1 adapterCache') < order.indexOf('1 columnIndex'), 'the gene index last');
  stop();
  for (const holder of [decoded, first, second, index]) holder.stop();
  assert.equal(memoryReport().holders, 0, 'unregistered holders are not counted');
});

test('a release level empties every cache of it: caches keep the gene index and undo steps, all keeps undo steps only', () => {
  const holders = Object.keys(RESIDENCY_SHARES).map(share => cache(share, [1024]));
  releaseResidentMemory('caches', 'hidden');
  const kept = share => holders.find((_, index) => Object.keys(RESIDENCY_SHARES)[index] === share).kept.length;
  for (const share of Object.keys(RESIDENCY_SHARES)) {
    assert.equal(kept(share), share === 'columnIndex' || share === 'undoHistory' ? 1 : 0, share);
  }
  releaseResidentMemory('all', 'frozen');
  assert.equal(kept('columnIndex'), 0);
  assert.equal(kept('undoHistory'), 1, 'the person\'s undo steps are never let go on their own');
  assert.throws(() => releaseResidentMemory('everything'), /Unknown release level/);
});

test('a refused allocation halves the allowance at once, trims what is over, says what went; evidence raises it back a step at a time', () => {
  const environment = { navigator: { deviceMemory: 8 } };
  const changes = [];
  const releases = [];
  onMemoryChange(reason => changes.push(reason));
  onMemoryReleased(event => releases.push(event));
  const allowance = memoryAllowanceBytes();
  const fields = cache('inactiveFields', [allowance / 8 * 0.4, allowance / 8 * 0.4], 'field arrays');
  // An array beyond what the engine allocates in one piece says nothing.
  assert.equal(recordAllocationFailure(allowance * 2, environment), false);
  assert.equal(memoryAllowanceBytes(), allowance);
  assert.equal(recordAllocationFailure(64 * MiB, environment), true);
  assert.equal(memoryAllowanceBytes(), allowance / 2);
  assert.deepEqual(changes, ['refused']);
  assert.equal(fields.kept.length, 1, 'the share over its halved budget gave back at once');
  assert.deepEqual(releases.map(event => event.reason), ['refused']);
  assert.equal(memoryReport().refusedBytes, 64 * MiB);
  // A smaller grant, or one while the app holds little, is no evidence.
  recordAllocationSuccess(MiB);
  recordAllocationSuccess(64 * MiB);
  assert.equal(memoryAllowanceBytes(), allowance / 2);
  // Granted the refused size while the app holds the lowered allowance: room beyond it.
  setOpenCells(Math.floor(memoryAllowanceBytes() / CELL_WORKING_SET_BYTES));
  recordAllocationSuccess(64 * MiB);
  assert.equal(memoryAllowanceBytes(), allowance, 'one step back: the whole allowance');
  assert.equal(memoryReport().refusedBytes, 0, 'no refusal holds any more');
  // Another dataset opening tries the refused size again.
  setOpenCells(0);
  recordAllocationFailure(32 * MiB, environment);
  recordAllocationFailure(32 * MiB, environment);
  assert.equal(memoryAllowanceBytes(), allowance / 4);
  retryRefusedAllocation();
  assert.equal(memoryAllowanceBytes(), allowance / 2, 'granted again: one step back');
  fields.stop();
});

test('other Cellucid pages of the origin divide the device: each uses what the others do not hold, at least an equal share', () => {
  const allowance = memoryAllowanceBytes();
  setOtherInstances({ count: 1, heldBytes: allowance * 0.3 });
  assert.equal(memoryAllowanceBytes(), Math.floor(allowance * 0.7));
  setOtherInstances({ count: 1, heldBytes: allowance * 0.9 });
  assert.equal(memoryAllowanceBytes(), allowance / 2, 'at least an equal share');
  setOtherInstances({ count: 3, heldBytes: allowance });
  assert.equal(memoryAllowanceBytes(), allowance / 4);
  assert.equal(memoryReport().instances, 4);
  setOtherInstances({ count: 0, heldBytes: 0 });
  assert.equal(memoryAllowanceBytes(), allowance);
});

test('a worker evaluates the page\'s state, reports what its caches keep, and its refusals lower the allowance everywhere', async () => {
  // The worker's own copy of the module: another thread.
  const worker = await import('../assets/js/data/memory-budget.js?thread=worker');
  worker.resetMemoryModel();
  const toWorker = [];
  const connection = connectMemoryWorker({
    postMessage: message => {
      toWorker.push(message);
      worker.receiveMemoryMessage(message);
    },
  });
  worker.setMemoryReporter(message => connection.receive(message));
  assert.ok(toWorker[0].memoryState, 'the page\'s state goes first');
  // The worker has no heap limit or deviceMemory of its own: the page's device counts.
  assert.equal(worker.memoryAllowanceBytes(), memoryAllowanceBytes());
  setOpenCells(1_000_000);
  assert.equal(worker.residencyBudgetBytes('columnIndex'), residencyBudgetBytes('columnIndex'), 'the same budgets in both threads');
  // What the worker's caches keep reaches the page.
  const index = [];
  worker.registerResidentHolder('columnIndex', { label: 'gene index', bytes: () => index.length * MiB, trim: budget => { while (index.length * MiB > budget) index.pop(); return null; } });
  index.push(1, 2, 3);
  worker.noteMemoryChanged();
  // Reported on a later task, once whatever else changes with it has.
  await until(() => heldBytes() > 0, 'the worker\'s report reached the page');
  assert.equal(memoryReport().shares.columnIndex.heldBytes, 3 * MiB);
  assert.equal(heldBytes(), 3 * MiB);
  // A refusal in the worker lowers the one allowance; every thread follows.
  const before = memoryAllowanceBytes();
  assert.equal(worker.recordAllocationFailure(MiB), true);
  assert.equal(memoryAllowanceBytes(), before / 2);
  assert.equal(worker.memoryAllowanceBytes(), memoryAllowanceBytes());
  // A release the page asks for reaches the worker's caches.
  releaseResidentMemory('all', 'frozen');
  assert.equal(index.length, 0);
  connection.disconnect();
  assert.equal(memoryReport().workers, 0);
  worker.resetMemoryModel();
});

test('a worker\'s part of the working set (a graph it builds) is counted by the page under its name, and every thread makes room', async () => {
  const worker = await import('../assets/js/data/memory-budget.js?thread=graph-builder');
  worker.resetMemoryModel();
  const connection = connectMemoryWorker({ postMessage: message => worker.receiveMemoryMessage(message) });
  worker.setMemoryReporter(message => connection.receive(message));
  const index = [];
  worker.registerResidentHolder('columnIndex', { label: 'gene index', bytes: () => index.length * MiB, trim: budget => { while (index.length * MiB > budget) index.pop(); return null; } });
  const room = cacheRoomBytes();
  for (let i = 0; i < Math.floor(residencyBudgetBytes('columnIndex') / MiB); i++) index.push(i);
  const kept = index.length;
  // The worker starts a build of half the cache room: the page counts it
  // at once, and the worker's cache over its new budget gives memory back.
  worker.setWorkingSet('graph build', Math.floor(room / 2));
  assert.equal(Object.entries(memoryReport().workingSet).find(([part]) => part.endsWith(': graph build'))?.[1], Math.floor(room / 2));
  assert.equal(worker.workingSetBytes(), workingSetBytes(), 'the worker evaluates the page\'s working set, its build included');
  assert.ok(index.length < kept, 'the worker\'s cache made room for its build');
  assert.throws(() => worker.setWorkingSet('graph build', 1, {}), /draws no object/);
  // Ended: dropped on the page.
  worker.setWorkingSet('graph build', 0);
  assert.equal(Object.keys(memoryReport().workingSet).some(part => part.endsWith(': graph build')), false);
  // A worker that goes away takes its parts with it.
  worker.setWorkingSet('graph build', MiB);
  assert.equal(workingSetBytes(), MiB);
  connection.disconnect();
  assert.equal(workingSetBytes(), 0);
  worker.resetMemoryModel();
});

test('the decode pool reads its own share', () => {
  const cores = count => ({ navigator: { hardwareConcurrency: count } });
  assert.equal(decodeWorkerCount(Infinity, cores(10)), 8);
  assert.equal(decodeWorkerCount(128 * MiB, cores(10)), 3);
  assert.equal(decodeWorkerCount(DECODE_WORKER_BYTES - 1, cores(10)), 0);
  assert.equal(decodeWorkerCount(Infinity, cores(2)), 1);
  assert.equal(decodeWorkerCount(Infinity, {}), 2);
  assert.equal(residencyBudgetBytes('analysis', { navigator: { deviceMemory: 8 } }), 256 * MiB);
  assert.equal(residencyBudgetBytes('analysisPages', { navigator: { deviceMemory: 2 } }), 64 * MiB);
});
