/**
 * Gene deliveries (`data/gene-delivery.js`): the genes an analysis computes
 * in its workers go from the AnnData reader worker to them over the run's
 * gene route, and never cross the page's thread.
 *
 * - The reader takes a route's ports (one per analysis worker), reads the
 *   genes a delivery names and posts them, transferred, to the workers it
 *   names: one worker, each worker its range of cells, or each run of a cell
 *   subset its worker. The page hears only their bytes.
 * - A delivery made for an older generation of a worker's port (the pool
 *   replaced the worker) is dropped.
 * - The analysis worker keeps what arrives in its inbox until the task naming
 *   it comes, or holds the task until it arrives; a task naming an older
 *   generation answers `{lost: true}` at once; a route closed under a waiting
 *   task fails it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createAnnDataReaderHandler } from '../assets/js/data/anndata-reader-worker.js';
import {
  lowerBoundOf,
  requireColumnDelivery,
  requireRunDelivery,
  sparseEntriesOf,
  splitColumnsByCellRanges,
  subsetRun,
} from '../assets/js/data/gene-delivery.js';

const FIXTURE = new URL('./browser/fixtures/current-ui-smoke.h5ad', import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));

/** A reader handler with the fixture open; `call(method, ...args)` answers its reply. */
async function openReader() {
  const handle = createAnnDataReaderHandler();
  let id = 1;
  const call = async (method, ...args) => handle({ id: id++, method, args });
  const { reply } = await call('open', { source: { file: new File([bytes], 'x.h5ad') } });
  assert.equal(reply.error, undefined);
  return { call, nObs: reply.result.nObs };
}

/** The next message a port receives. */
function nextMessage(port) {
  return new Promise(resolve => {
    port.onmessage = event => {
      port.onmessage = null;
      resolve(event.data);
    };
  });
}

/** Whether a port receives anything within a few turns. */
async function receivesNothing(port) {
  let received = false;
  port.onmessage = () => { received = true; };
  for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
  port.onmessage = null;
  return !received;
}

test('the reader delivers a task\'s genes to its worker and answers only their bytes', async () => {
  const { call } = await openReader();
  const channels = [new MessageChannel(), new MessageChannel()];
  const opened = await call('openRoute', 'route-1', channels.map(channel => channel.port1));
  assert.equal(opened.reply.error, undefined);

  const expected = (await call('getMatrixColumnsSparse', 'X', [0, 2, 5])).reply.result;
  const arriving = [nextMessage(channels[1].port2), nextMessage(channels[0].port2)];
  // One read, two tasks: genes 0 and 2 to worker 1, gene 5 to worker 0.
  const { reply } = await call('deliverColumns', 'X', [0, 2, 5], 'job-1', {
    route: 'route-1',
    runs: [{ id: 7, worker: 1, generation: 0, first: 0, last: 2 }, { id: 8, worker: 0, generation: 0, first: 2, last: 3 }],
  });
  assert.deepEqual(Object.keys(reply.result), ['bytes'], 'the page hears only the bytes');
  assert.deepEqual(reply.result.bytes, expected.map(column => column.indices.byteLength + column.values.byteLength));
  const [toOne, toZero] = await Promise.all(arriving);
  assert.equal(toOne.id, 7);
  assert.equal(toOne.generation, 0);
  assert.equal(toZero.id, 8);
  [...toOne.columns, ...toZero.columns].forEach((column, k) => {
    assert.equal(column.length, expected[k].length);
    assert.deepEqual([...column.indices], [...expected[k].indices]);
    assert.deepEqual([...column.values], [...expected[k].values]);
  });
  assert.equal(toOne.columns.length, 2);
  assert.equal(toZero.columns.length, 1);

  // A worker the pool replaced has a newer port: a delivery for the old one is dropped.
  const replacement = new MessageChannel();
  assert.equal((await call('replaceRoutePort', 'route-1', 1, replacement.port1, 1)).reply.error, undefined);
  const stale = await call('deliverColumns', 'X', [1], null, { route: 'route-1', runs: [{ id: 9, worker: 1, generation: 0, first: 0, last: 1 }] });
  assert.equal(stale.reply.error, undefined);
  assert.ok(await receivesNothing(replacement.port2), 'a delivery made for the replaced worker never comes');
  const fresh = nextMessage(replacement.port2);
  await call('deliverColumns', 'X', [1], null, { route: 'route-1', runs: [{ id: 10, worker: 1, generation: 1, first: 0, last: 1 }] });
  assert.equal((await fresh).id, 10);

  assert.equal((await call('closeRoute', 'route-1')).reply.error, undefined);
  const closed = await call('deliverColumns', 'X', [1], null, { route: 'route-1', runs: [{ id: 11, worker: 0, generation: 0, first: 0, last: 1 }] });
  assert.match(closed.reply.error.message, /No gene route 'route-1'/);
  for (const channel of [...channels, replacement]) channel.port2.close();
});

test('a split delivery gives each worker its range of cells; a cell subset each run its worker', async () => {
  const { call, nObs } = await openReader();
  const channels = [new MessageChannel(), new MessageChannel(), new MessageChannel()];
  await call('openRoute', 'route-2', channels.map(channel => channel.port1));
  const split = Uint32Array.of(0, 40, 80, nObs);
  const columns = (await call('getMatrixColumnsSparse', 'X', [0, 3])).reply.result;
  const arriving = channels.map(channel => nextMessage(channel.port2));
  await call('deliverColumns', 'X', [0, 3], null, { route: 'route-2', id: 1, split, generations: [0, 0, 0] });
  const parts = await Promise.all(arriving);
  parts.forEach((part, worker) => {
    const from = split[worker];
    const to = split[worker + 1];
    assert.equal(part.id, 1);
    columns.forEach((column, gene) => {
      const first = lowerBoundOf(column.indices, from);
      const last = lowerBoundOf(column.indices, to);
      const { pointers, cells, values } = part.ranges;
      assert.deepEqual([...cells.subarray(pointers[gene], pointers[gene + 1])], [...column.indices.subarray(first, last)].map(cell => cell - from));
      assert.deepEqual([...values.subarray(pointers[gene], pointers[gene + 1])], [...column.values.subarray(first, last)]);
    });
  });

  const cells = Uint32Array.of(3, 9, 30, 64, 101);
  const block = (await call('getMatrixCellSubset', 'X', cells, Uint32Array.of(0, 1, 2, 3))).reply.result;
  const runs = [nextMessage(channels[2].port2), nextMessage(channels[0].port2)];
  const { reply } = await call('deliverCellSubset', 'X', cells, Uint32Array.of(0, 1, 2, 3), null, {
    route: 'route-2',
    runs: [
      { id: 2, worker: 2, generation: 0, first: 0, last: 3 },
      { id: 3, worker: 0, generation: 0, first: 3, last: 4 },
    ],
  });
  assert.deepEqual(Object.keys(reply.result), ['bytes']);
  const [first, second] = await Promise.all(runs);
  assert.deepEqual(first.block, subsetRun(block, 0, 3));
  assert.deepEqual(second.block, subsetRun(block, 3, 4));
  await call('closeRoute', 'route-2');
  for (const channel of channels) channel.port2.close();
});

test('a delivery names where it goes, and its runs cover its genes in order', () => {
  assert.throws(() => requireColumnDelivery({ route: 'r', id: 1 }, 1), /runs/);
  assert.throws(() => requireColumnDelivery({ route: '', runs: [{ id: 1, worker: 0, generation: 0, first: 0, last: 1 }] }, 1), /route/);
  assert.throws(() => requireColumnDelivery({ route: 'r', id: 1, split: Uint32Array.of(0, 5), generations: [] }, 1), /one range/);
  assert.throws(() => requireColumnDelivery({ route: 'r', id: 1, split: Uint32Array.of(5, 0), generations: [0] }, 1), /ascend/);
  assert.ok(requireColumnDelivery({ route: 'r', runs: [{ id: 1, worker: 0, generation: 2, first: 0, last: 1 }] }, 1));
  assert.throws(() => requireRunDelivery({ route: 'r', runs: [{ id: 1, worker: 0, generation: 0, first: 0, last: 2 }] }, 3), /cover/);
  assert.throws(() => requireRunDelivery({ route: 'r', runs: [{ id: 1, worker: 0, generation: 0, first: 1, last: 3 }] }, 3), /cover/);
  assert.ok(requireRunDelivery({ route: 'r', runs: [{ id: 1, worker: 0, generation: 0, first: 0, last: 3 }] }, 3));
});

test('a dense column becomes its non-zero entries, NaN kept; ranges split every gene', () => {
  const sparse = sparseEntriesOf(Float32Array.of(0, 2, NaN, 0, 5));
  assert.deepEqual([...sparse.indices], [1, 2, 4]);
  assert.deepEqual([...sparse.values], [2, NaN, 5]);
  const same = { length: 3, indices: Uint32Array.of(1), values: Float32Array.of(4) };
  assert.equal(sparseEntriesOf(same), same);
  const [low, high] = splitColumnsByCellRanges([sparse, same], [0, 2, 5]);
  assert.deepEqual([...low.pointers], [0, 1, 2]);
  assert.deepEqual([...low.cells], [1, 1]);
  assert.deepEqual([...high.pointers], [0, 2, 2]);
  assert.deepEqual([...high.cells], [0, 2], 'cells counted from the range\'s start');
  assert.deepEqual([...high.values], [NaN, 5]);
});

/**
 * The analysis worker's handler, run in-process (`data-worker.js` with a
 * stand-in `self`, which every instance answers through: requests are
 * named per instance).
 */
const answers = new Map();
async function analysisWorker(name) {
  globalThis.self = {
    postMessage: message => {
      answers.get(message.requestId)?.(message);
      answers.delete(message.requestId);
    },
  };
  await import(`../assets/js/app/analysis/compute/data-worker.js?${name}`);
  const handler = globalThis.self.onmessage;
  let next = 0;
  return {
    send(type, payload, transfer = []) {
      const requestId = `${name}-${next++}`;
      const answered = new Promise(resolve => answers.set(requestId, resolve));
      const data = transfer.length > 0 ? structuredClone({ type, payload, requestId }, { transfer }) : { type, payload, requestId };
      handler({ data });
      return answered;
    },
  };
}

test('the analysis worker runs a task on its delivery, whichever arrives first', async () => {
  const worker = await analysisWorker('gene-delivery-inbox');
  const channel = new MessageChannel();
  const opened = await worker.send('GENE_ROUTE_OPEN', { route: 'r', generation: 0, port: channel.port2 }, [channel.port2]);
  assert.equal(opened.success, true);
  await worker.send('MARKERS_SET_CONTEXT', {
    codes: Uint8Array.of(0, 0, 1, 1),
    codeToGroupIndex: Int32Array.of(0, 1),
    groupCount: 2,
    tested: Uint8Array.of(1, 1),
    reference: -1,
  });
  const base = { method: 'ttest', minCells: 2, pConvention: 'exact', foldChange: { mode: 'stored' } };
  const column = () => ({ length: 4, indices: Uint32Array.of(0, 1, 2, 3), values: Float32Array.of(1, 2, 3, 4) });
  const direct = (await worker.send('MARKERS_COMPUTE_GENES', { ...base, columns: [column()] })).result;

  // The genes arrive first, then the task naming them.
  channel.port1.postMessage({ id: 1, generation: 0, columns: [column()] });
  await new Promise(resolve => setImmediate(resolve));
  const first = await worker.send('MARKERS_COMPUTE_GENES', { ...base, delivery: { route: 'r', id: 1, generation: 0 } });
  assert.equal(first.success, true);
  assert.deepEqual([...first.result.pValues], [...direct.pValues]);

  // The task first: it waits for its genes.
  const second = worker.send('MARKERS_COMPUTE_GENES', { ...base, delivery: { route: 'r', id: 2, generation: 0 } });
  await new Promise(resolve => setImmediate(resolve));
  channel.port1.postMessage({ id: 2, generation: 0, columns: [column()] });
  assert.deepEqual([...(await second).result.meanInGroup], [...direct.meanInGroup]);

  // This worker replaced the one a delivery went to: lost at once.
  const replacement = new MessageChannel();
  await worker.send('GENE_ROUTE_OPEN', { route: 'r', generation: 1, port: replacement.port2 }, [replacement.port2]);
  const lost = await worker.send('MARKERS_COMPUTE_GENES', { ...base, delivery: { route: 'r', id: 3, generation: 0 } });
  assert.deepEqual(lost.result, { lost: true });

  // A route closed under a waiting task fails it.
  const waiting = worker.send('MARKERS_COMPUTE_GENES', { ...base, delivery: { route: 'r', id: 4, generation: 1 } });
  await new Promise(resolve => setImmediate(resolve));
  const closed = await worker.send('GENE_ROUTE_CLOSE', { route: 'r' });
  assert.deepEqual(closed.result, { released: true });
  const failed = await waiting;
  assert.equal(failed.success, false);
  assert.match(failed.error, /closed before its genes arrived/);
  const unknown = await worker.send('MARKERS_COMPUTE_GENES', { ...base, delivery: { route: 'r', id: 5, generation: 1 } });
  assert.match(unknown.error, /No gene route 'r'/);
  channel.port1.close();
  replacement.port1.close();
});

test('UCell takes its set genes and every gene as its range\'s entries', async () => {
  const worker = await analysisWorker('gene-delivery-ucell');
  const channel = new MessageChannel();
  await worker.send('GENE_ROUTE_OPEN', { route: 'u', generation: 0, port: channel.port2 }, [channel.port2]);
  // Three cells, two set genes: one delivered (slot 1), one only the page held (slot 0).
  channel.port1.postMessage({ id: 0, generation: 0, ranges: { pointers: Uint32Array.of(0, 2), cells: Uint32Array.of(0, 2), values: Float32Array.of(5, 1) } });
  const context = await worker.send('UCELL_SET_CONTEXT', {
    cellCount: 3,
    setGeneCount: 2,
    geneCount: 3,
    sets: [[0, 1]],
    maxRank: 3,
    slots: Uint32Array.of(1),
    delivery: { route: 'u', id: 0, generation: 0 },
    inline: { slots: Uint32Array.of(0), ranges: { pointers: Uint32Array.of(0, 1), cells: Uint32Array.of(1), values: Float32Array.of(2) } },
  });
  assert.deepEqual(context.result, { cells: 3 });
  channel.port1.postMessage({ id: 1, generation: 0, ranges: { pointers: Uint32Array.of(0, 1, 2, 3), cells: Uint32Array.of(0, 1, 2), values: Float32Array.of(9, 9, 9) } });
  const added = await worker.send('UCELL_ADD_GENES', { delivery: { route: 'u', id: 1, generation: 0 } });
  assert.deepEqual(added.result, { added: 3 });
  const finished = await worker.send('UCELL_FINISH', {});
  assert.equal(finished.result.scores.length, 3);
  await worker.send('GENE_ROUTE_CLOSE', { route: 'u' });
  channel.port1.close();
});
