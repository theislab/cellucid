import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RowMajorColumnIndex,
  createColumnStoreFactory,
  sparseIndexPlan,
} from '../assets/js/data/sparse-column-index.js';
import { columnIndexMemoryBudget } from '../assets/js/data/column-store-placement.js';
import { checksumOf } from '../assets/js/formats/io/page-checks.js';

import { until } from './helpers/until.mjs';

// A deterministic CSR matrix with duplicate coordinates and empty rows.
function csrFixture(nRows, nCols, seed = 7) {
  const indptr = [0];
  const indices = [];
  const data = [];
  let state = seed;
  // xorshift32: exact integer arithmetic, so the fixture is not degenerate.
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  for (let row = 0; row < nRows; row++) {
    const count = next() % 4;
    for (let k = 0; k < count; k++) {
      indices.push(next() % nCols);
      data.push(((next() % 1000) + 1) / 8);
    }
    indptr.push(indices.length);
  }
  return {
    nRows,
    nCols,
    indptr: Float64Array.from(indptr),
    indices: Int32Array.from(indices),
    data: Float32Array.from(data),
  };
}

function denseColumn(fixture, column) {
  const out = new Float32Array(fixture.nRows);
  for (let row = 0; row < fixture.nRows; row++) {
    for (let entry = fixture.indptr[row]; entry < fixture.indptr[row + 1]; entry++) {
      if (fixture.indices[entry] === column) {
        out[row] = Math.fround(out[row] + fixture.data[entry]);
      }
    }
  }
  return out;
}

function sparseIndex(fixture, storeFactory, overrides = {}) {
  const reads = { pointers: 0, indices: 0, values: 0 };
  const index = new RowMajorColumnIndex({
    layout: 'sparse',
    nRows: fixture.nRows,
    nCols: fixture.nCols,
    nnz: fixture.indices.length,
    readRowPointers: (start, end) => {
      reads.pointers++;
      return fixture.indptr.slice(start, end);
    },
    readIndices: (start, end) => {
      reads.indices++;
      return fixture.indices.slice(start, end);
    },
    readValues: (start, end) => {
      reads.values++;
      return fixture.data.slice(start, end);
    },
    storeFactory,
    slabEntries: 16,
    label: 'X',
    ...overrides,
  });
  return { index, reads };
}

/** A FileSystemSyncAccessHandle stand-in over growable memory. */
function fakeSyncHandle() {
  let bytes = new Uint8Array(0);
  return {
    closed: false,
    writes: 0,
    truncate(size) {
      const next = new Uint8Array(size);
      next.set(bytes.subarray(0, Math.min(size, bytes.length)));
      bytes = next;
    },
    write(view, { at }) {
      this.writes++;
      const source = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      bytes.set(source, at);
      return source.length;
    },
    read(view, { at }) {
      const target = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      target.set(bytes.subarray(at, at + target.length));
      return target.length;
    },
    getSize() {
      return bytes.length;
    },
    flush() {},
    close() {
      this.closed = true;
    },
  };
}

test('every column of a CSR matrix equals a direct scan, from memory', async () => {
  const fixture = csrFixture(200, 11);
  assert.ok(fixture.indices.length > 200, 'the fixture has entries, duplicates and empty rows');
  const { index } = sparseIndex(fixture, createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }));
  await index.start();
  assert.equal(index.storeKind, 'memory');
  for (let column = 0; column < fixture.nCols; column++) {
    assert.deepEqual(await index.column(column), denseColumn(fixture, column));
  }

  // Keeping pass 1's indices for pass 2 reads them once and builds the same store.
  const retaining = sparseIndex(fixture, createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }), {
    retainIndicesBytes: 1 << 30,
  });
  await retaining.index.start();
  const reads = retaining.reads.indices;
  for (let column = 0; column < fixture.nCols; column++) {
    assert.deepEqual(await retaining.index.column(column), denseColumn(fixture, column));
  }
  const plain = sparseIndex(fixture, createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }));
  await plain.index.start();
  assert.equal(reads * 2, plain.reads.indices);
});

test('a store over the memory budget spills to disk and reads back identically', async () => {
  const fixture = csrFixture(300, 13);
  const handles = { rows: fakeSyncHandle(), values: fakeSyncHandle(), released: false };
  handles.release = () => { handles.released = true; };
  const factory = createColumnStoreFactory({
    memoryBudgetBytes: 0,
    openDiskFiles: async names => {
      assert.deepEqual(names, ['rows', 'values']);
      return handles;
    },
  });
  const { index } = sparseIndex(fixture, factory);
  await index.start();
  assert.equal(index.storeKind, 'disk');
  for (let column = 0; column < fixture.nCols; column++) {
    assert.deepEqual(await index.column(column), denseColumn(fixture, column));
  }
  index.dispose();
  assert.equal(handles.rows.closed, true);
  assert.equal(handles.values.closed, true);
  assert.equal(handles.released, true);
});

test('a gene asked for mid-build is served from the build passes, before the index is complete', async () => {
  const fixture = csrFixture(400, 9);
  // The build waits at every slab boundary until the test lets it go on.
  let slabs = 0;
  let release = null;
  const yieldControl = () => new Promise(resolve => {
    slabs++;
    release = resolve;
  });
  let done = false;
  const step = async () => {
    while (release === null && !done) await new Promise(resolve => setImmediate(resolve));
    if (release === null) return;
    const go = release;
    release = null;
    go();
  };
  const { index } = sparseIndex(fixture, createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }), {
    yieldControl,
  });
  const building = index.start();
  for (let i = 0; i < 5; i++) await step();
  let resolvedAtSlab = null;
  const column = index.column(4).then(values => {
    resolvedAtSlab = slabs;
    return values;
  });
  building.then(() => { done = true; }, () => { done = true; });
  while (!done) await step();
  assert.deepEqual(await column, denseColumn(fixture, 4));
  assert.ok(resolvedAtSlab !== null && resolvedAtSlab < slabs,
    `served at slab ${resolvedAtSlab} of ${slabs}`);
  assert.equal(index.phase, 'ready');
});

test('with no memory and no disk, genes are answered by scanning, never refused, and never silently', async () => {
  const fixture = csrFixture(150, 7);
  const reason = 'the gene index needs 32 GB: more than the 3 GB of memory this browser keeps for it, and no disk';
  const factory = {
    sparse: async () => ({ store: null, refusal: reason }),
    dense: async () => ({ store: null, refusal: reason }),
  };
  const events = [];
  const scans = [];
  const { index, reads } = sparseIndex(fixture, factory, {
    onProgress: event => events.push(event),
    onUnindexedScan: why => {
      const scan = { why, ended: false, error: undefined };
      scans.push(scan);
      return error => {
        scan.ended = true;
        scan.error = error;
      };
    },
  });
  await index.start();
  assert.equal(index.phase, 'unindexed');
  assert.equal(index.unindexedReason, reason);
  assert.ok(events.some(event => event.phase === 'unindexed' && event.reason === reason), 'the reason goes out with the progress');
  const [a, b] = await Promise.all([index.column(1), index.column(5)]);
  assert.deepEqual(a, denseColumn(fixture, 1));
  assert.deepEqual(b, denseColumn(fixture, 5));
  assert.equal(scans.length, 1, 'genes asked for together share one announced scan');
  const before = reads.indices;
  assert.deepEqual(await index.column(1), denseColumn(fixture, 1));
  assert.ok(reads.indices > before, 'a later gene scans the matrix again');
  assert.ok(scans.length >= 2, 'and that pass is announced too');
  // A scan ends after the gene it served, past its own yields.
  await until(() => scans.every(scan => scan.ended), 'every scan ended');
  assert.ok(scans.every(scan => scan.ended && scan.error === null && scan.why === reason));
});

test('a gene withdrawn by its caller stops a build no one else waits for; the next gene starts over', async () => {
  const fixture = csrFixture(400, 9);
  let pointerReads = 0;
  const { index, reads } = sparseIndex(fixture, createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }), {
    readRowPointers: (start, end) => {
      pointerReads++;
      return fixture.indptr.slice(start, end);
    },
    yieldControl: () => new Promise(resolve => setTimeout(resolve, 0)),
  });
  const controller = new AbortController();
  const read = index.column(3, { signal: controller.signal });
  const build = index.start();
  await until(() => pointerReads > 0, 'the build reading');
  controller.abort(new DOMException('The person canceled', 'AbortError'));
  await assert.rejects(read, { name: 'AbortError', message: 'The person canceled' });
  await assert.rejects(build, error => error.indexStopped === true);
  assert.equal(index.phase, 'idle', 'the stopped build is forgotten');
  const readsWhenStopped = reads.indices;
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(reads.indices, readsWhenStopped, 'nothing is read once it stopped');
  assert.deepEqual(await index.column(3), denseColumn(fixture, 3));
  await index.start();
  assert.equal(index.phase, 'ready');
  assert.ok(pointerReads > 0);
});

test('a stopped build aborts its queued reads; a gene asked for as it stops is served whole by the next build', async () => {
  const fixture = csrFixture(400, 9);
  const signals = [];
  const builds = [];
  // The first build's reads are held until it stops: it cannot end first.
  let holding = true;
  const { index } = sparseIndex(fixture, createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }), {
    readIndices: (start, end, { signal } = {}) => {
      signals.push(signal);
      // A slow host: each slab arrives a moment later, unless the read is let go.
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const timer = holding ? null : setTimeout(() => resolve(fixture.indices.slice(start, end)), 1);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
    },
    onBuild: build => builds.push(build),
  });
  const controller = new AbortController();
  const withdrawn = index.column(6, { signal: controller.signal });
  await until(() => signals.length > 0, 'the build reading');
  controller.abort(new DOMException('cancelled', 'AbortError'));
  assert.ok(signals.length > 0 && signals.every(signal => signal.aborted), 'every read of the stopped build is let go');
  holding = false;
  // Asked for before the stopped build has let go: served whole, by a new build.
  const again = index.column(6);
  await assert.rejects(withdrawn, { name: 'AbortError' });
  assert.deepEqual(await again, denseColumn(fixture, 6));
  assert.equal(builds.length, 2, 'a second build started for the gene asked for again');
});

test('without an index, a scan whose genes all withdrew stops its reads; the next gene scans again', async () => {
  const fixture = csrFixture(400, 9);
  const reason = 'the gene index needs 1 GB: nothing can hold it';
  const signals = [];
  const scans = [];
  // The withdrawn gene's scan has its reads held until it stops: it cannot end first.
  let holding = false;
  const { index } = sparseIndex(fixture, {
    sparse: async () => ({ store: null, refusal: reason }),
    dense: async () => ({ store: null, refusal: reason }),
  }, {
    readIndices: (start, end, { signal } = {}) => {
      signals.push(signal);
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const timer = holding ? null : setTimeout(() => resolve(fixture.indices.slice(start, end)), 1);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
    },
    onUnindexedScan: () => {
      const scan = { error: undefined, from: signals.length };
      scans.push(scan);
      return error => { scan.error = error; };
    },
  });
  await index.start();
  assert.equal(index.phase, 'unindexed');
  holding = true;
  const controller = new AbortController();
  const withdrawn = index.column(4, { signal: controller.signal });
  await until(() => scans.length === 1 && signals.length > scans[0].from, 'the scan reading');
  const before = signals.length;
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(withdrawn, { name: 'AbortError' });
  await until(() => scans[0].error !== undefined, 'the stopped scan ended');
  assert.ok(before > scans[0].from && signals.slice(scans[0].from, before).every(signal => signal.aborted),
    'the stopped scan lets its reads go');
  assert.equal(scans[0].error?.indexStopped, true, 'its activity ends as stopped');
  holding = false;
  assert.deepEqual(await index.column(4), denseColumn(fixture, 4));
  assert.equal(scans.length, 2);
  await until(() => scans[1].error !== undefined, 'the second scan ended');
  assert.equal(scans[1].error, null);
});

test('once a gene was served, cancelling a later one never discards the build: pass 2 goes on, pass 1 is not read again', async () => {
  const fixture = csrFixture(400, 9);
  const reads = { indices: 0 };
  const slow = array => (start, end, { signal } = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(array.slice(start, end)), 1);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
  const readIndices = slow(fixture.indices);
  const { index } = sparseIndex(fixture, createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }), {
    readIndices: (start, end, options) => {
      reads.indices++;
      return readIndices(start, end, options);
    },
    readValues: slow(fixture.data),
  });
  // The first gene is served at the end of pass 1.
  assert.deepEqual(await index.column(3), denseColumn(fixture, 3));
  while (index.phase !== 'indexing') await new Promise(resolve => setTimeout(resolve, 1));
  const pass1Reads = reads.indices;
  const controller = new AbortController();
  const second = index.column(5, { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 3));
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(second, { name: 'AbortError' });
  await index.start();
  assert.equal(index.phase, 'ready', 'pass 2 went on');
  assert.deepEqual(await index.column(5), denseColumn(fixture, 5));
  assert.ok(reads.indices <= 2 * pass1Reads, 'pass 1 was not read again');
  assert.equal(index._retainedIndices, null, 'what pass 1 kept for pass 2 is let go once built');
});

test('a build that fails in pass 2 lets go of what pass 1 kept for it', async () => {
  const fixture = csrFixture(300, 8);
  let pass2 = false;
  const { index } = sparseIndex(fixture, createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }), {
    retainIndicesBytes: 1 << 20,
    readValues: (start, end) => {
      if (pass2) return Promise.reject(new Error('the host stopped answering'));
      return fixture.data.slice(start, end);
    },
    onProgress: event => {
      if (event.phase === 'indexing') pass2 = true;
    },
  });
  await assert.rejects(index.start(), /the host stopped answering/);
  assert.equal(index._retainedIndices, null);
  assert.equal(index._retainedValues, null);
  assert.deepEqual(index._besideKept, []);
});

test('pass 2 says exactly what it reads again: nothing pass 1 kept, every slab whose values it did not read', async () => {
  const fixture = csrFixture(300, 8);
  const nnz = fixture.indices.length;
  const plan = budget => sparseIndexPlan({ nnz, nCols: 8, nRows: 300, valuesOnDemand: false, retainIndicesBytes: budget });
  const storeBytes = nnz * 8 + 8 * 16;
  // Every value fits beside the kept indices (uint8 for 8 genes): both kept.
  assert.equal(plan(storeBytes + nnz * 5).keepsValues, true);
  assert.equal(plan(storeBytes + nnz * 5 - 1).keepsValues, false);
  assert.equal(plan(storeBytes + nnz * 5 - 1).keepsIndices, true);
  assert.equal(plan(storeBytes).keepsIndices, false);
  const run = async (budget, { waitFrom }) => {
    let reads = null;
    let slab = 0;
    const { index } = sparseIndex(fixture, createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }), {
      retainIndicesBytes: budget,
      onSecondPass: value => { reads = value; },
      readIndices: (start, end) => {
        if (slab++ === waitFrom) index.column(2);
        return fixture.indices.slice(start, end);
      },
    });
    if (waitFrom === 0) index.column(2);
    await index.start();
    return reads;
  };
  // A gene waiting from the start, everything kept: pass 2 reads only the pointers.
  assert.deepEqual(await run(storeBytes + nnz * 5, { waitFrom: 0 }), { indices: [], values: [] });
  // Values not kept: every value again; indices not kept either: those too.
  assert.deepEqual(await run(storeBytes + nnz * 5 - 1, { waitFrom: 0 }), { indices: [], values: [[0, nnz]] });
  assert.deepEqual(await run(storeBytes, { waitFrom: 0 }), { indices: [[0, nnz]], values: [[0, nnz]] });
  // A gene asked for during pass 1: the slabs read before it, again.
  const late = await run(storeBytes + nnz * 5, { waitFrom: 5 });
  assert.equal(late.indices.length, 0);
  assert.equal(late.values.length, 1);
  assert.equal(late.values[0][0], 0);
  assert.ok(late.values[0][1] > 0 && late.values[0][1] < nnz, `the first slabs only, got ${late.values}`);
});

test('a withdrawn gene does not stop a build another gene still waits for, nor one asked for ahead', async () => {
  const fixture = csrFixture(300, 8);
  const factory = createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 });
  const slow = { yieldControl: () => new Promise(resolve => setTimeout(resolve, 0)) };
  const shared = sparseIndex(fixture, factory, slow).index;
  const controller = new AbortController();
  const withdrawn = shared.column(2, { signal: controller.signal });
  const kept = shared.column(2);
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(withdrawn, { name: 'AbortError' });
  assert.deepEqual(await kept, denseColumn(fixture, 2));
  await shared.start();
  assert.equal(shared.phase, 'ready');

  const ahead = sparseIndex(fixture, factory, slow).index;
  const built = ahead.start({ ahead: true });
  const other = new AbortController();
  const read = ahead.column(4, { signal: other.signal });
  other.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(read, { name: 'AbortError' });
  await built;
  assert.equal(ahead.phase, 'ready');
});

test('the store factory says why nothing can hold an index: the disk quota, or no disk', async () => {
  const columnStart = Float64Array.from([0, 3, 5]);
  const noDisk = createColumnStoreFactory({ memoryBudgetBytes: 8 });
  const none = await noDisk.sparse(4, 2, columnStart, 'X');
  // Over the budget and no disk: memory regardless, when the browser allows it.
  assert.equal(none.store?.kind, 'memory');
  const quota = createColumnStoreFactory({
    memoryBudgetBytes: 8,
    openDiskFiles: async () => assert.fail('the disk is not opened when the quota cannot hold the index'),
    diskFreeBytes: async () => 10,
  });
  assert.deepEqual(await quota.plan(2 ** 30), {
    kind: null,
    refusal: 'the gene index needs 1.0 GB: more than the 8 B of memory this browser keeps for it, ' +
      'and 10 B of disk storage is left to this site',
  });
  const full = createColumnStoreFactory({
    memoryBudgetBytes: 8,
    openDiskFiles: async () => {
      const handle = fakeSyncHandle();
      handle.truncate = () => { throw new DOMException('The disk is full', 'QuotaExceededError'); };
      return { rows: handle, values: handle, release() {} };
    },
  });
  const placed = await full.sparse(4, 2, columnStart, 'X');
  assert.equal(placed.store?.kind, 'memory', 'a full disk falls back to memory when the browser allows it');
});

test('a contiguous dense matrix is indexed in row slabs', async () => {
  const nRows = 37;
  const nCols = 5;
  const values = Float32Array.from({ length: nRows * nCols }, (_, i) => i / 4);
  for (const memoryBudgetBytes of [1 << 30, 0]) {
    const valuesHandle = fakeSyncHandle();
    const index = new RowMajorColumnIndex({
      layout: 'dense',
      nRows,
      nCols,
      readRows: (rowStart, rowEnd) => values.slice(rowStart * nCols, rowEnd * nCols),
      storeFactory: createColumnStoreFactory({
        memoryBudgetBytes,
        openDiskFiles: async () => ({ values: valuesHandle }),
      }),
      slabEntries: 20,
      label: 'X',
    });
    await index.start();
    assert.equal(index.storeKind, memoryBudgetBytes === 0 ? 'disk' : 'memory');
    for (let column = 0; column < nCols; column++) {
      assert.deepEqual(
        Array.from(await index.column(column)),
        Array.from({ length: nRows }, (_, row) => values[row * nCols + column])
      );
    }
  }
});

test('malformed CSR structure is refused, never clamped', async () => {
  const factory = createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 });
  const base = csrFixture(10, 3);
  const nonMonotonic = {
    nRows: 3,
    nCols: 2,
    indptr: Float64Array.from([0, 2, 1, 3]),
    indices: Int32Array.from([0, 1, 0]),
    data: Float32Array.from([1, 1, 1]),
  };
  await assert.rejects(sparseIndex(nonMonotonic, factory).index.start(), /indptr must be monotonic/);
  assert.ok(base.indices.length > 0);
  const outside = { ...base, indices: Int32Array.from(base.indices) };
  outside.indices[0] = 3;
  await assert.rejects(sparseIndex(outside, factory).index.start(), /outside its 3-column shape/);
});

test('the column-index memory budget is its share of the estimated device memory', () => {
  const GiB = 1024 ** 3;
  // Three eighths of the allowance, half the device.
  assert.equal(columnIndexMemoryBudget({ navigator: { deviceMemory: 8 } }), 1.5 * GiB);
  assert.equal(
    columnIndexMemoryBudget({ navigator: {}, performance: { memory: { jsHeapSizeLimit: 4 * GiB } } }),
    3 * GiB
  );
  assert.equal(columnIndexMemoryBudget({}), 1.5 * GiB);
});

test('a retired index still answers the genes already asked for, then lets go', async () => {
  const fixture = csrFixture(120, 5);
  let diskOpened = 0;
  const { index } = sparseIndex(fixture, createColumnStoreFactory({
    memoryBudgetBytes: 0,
    openDiskFiles: async () => {
      diskOpened++;
      return { rows: fakeSyncHandle(), values: fakeSyncHandle() };
    },
  }));
  const pending = index.column(3);
  index.retire();
  // Served from the counting pass; no store is built for an index nobody
  // will ask again, so nothing is written to disk.
  assert.deepEqual(await pending, denseColumn(fixture, 3));
  await index.start().catch(() => {});
  assert.equal(diskOpened, 0);

  // A store already being filled when its last reader leaves is removed.
  let released = 0;
  const filling = sparseIndex(fixture, createColumnStoreFactory({
    memoryBudgetBytes: 0,
    openDiskFiles: async () => ({
      rows: fakeSyncHandle(),
      values: fakeSyncHandle(),
      release: () => { released++; },
    }),
  }), {
    yieldControl: async () => {
      if (filling.index._filling) filling.index.retire();
    },
  });
  await filling.index.start().catch(() => {});
  assert.equal(released, 1);

  const idle = sparseIndex(fixture, createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 })).index;
  idle.retire();
  await assert.rejects(idle.column(0), /released|superseded/);
});

/** An index over the network: values read on demand, every read range recorded. */
function onDemandIndex(fixture) {
  const valueRanges = [];
  const { index, reads } = sparseIndex(fixture, createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }), {
    valuesOnDemand: true,
    retainIndicesBytes: 1 << 30,
    readValues: async (start, end) => {
      valueRanges.push([start, end]);
      return fixture.data.slice(start, end);
    },
  });
  return { index, reads, valueRanges };
}

test('over the network a sparse matrix is indexed by its indices alone', async () => {
  const fixture = csrFixture(4000, 300);
  const { index, reads, valueRanges } = onDemandIndex(fixture);
  await index.start();
  assert.equal(index.phase, 'ready');
  assert.ok(reads.indices > 0);
  assert.equal(valueRanges.length, 0, 'no value is read until a gene is asked for');
  for (const column of [0, 7, 150, 299]) {
    assert.deepEqual(await index.column(column), denseColumn(fixture, column));
  }
});

test('a gene asked for during the pass reads only its own entries\' values', async () => {
  const fixture = csrFixture(4000, 300);
  const { index, valueRanges } = onDemandIndex(fixture);
  const column = await index.column(42);
  assert.deepEqual(column, denseColumn(fixture, 42));
  const read = valueRanges.reduce((sum, [start, end]) => sum + end - start, 0);
  assert.ok(read < fixture.data.length / 4, `read ${read} of ${fixture.data.length} values`);
});

test('a gene spread over the whole matrix reads every value once, then every gene is answered from memory', async () => {
  // Every row holds column 0; other columns are rare.
  const nRows = 60_000;
  const indptr = [0];
  const indices = [];
  const data = [];
  for (let row = 0; row < nRows; row++) {
    indices.push(0);
    data.push(1 + (row % 5));
    if (row % 997 === 0) {
      indices.push(1 + (row % 50));
      data.push(2);
    }
    indptr.push(indices.length);
  }
  const fixture = { nRows, nCols: 51, indptr: Float64Array.from(indptr), indices: Int32Array.from(indices), data: Float32Array.from(data) };
  const { index, valueRanges } = onDemandIndex(fixture);
  await index.start();
  assert.deepEqual(await index.column(0), denseColumn(fixture, 0));
  const afterCommon = valueRanges.length;
  const covered = valueRanges.reduce((sum, [start, end]) => sum + end - start, 0);
  assert.equal(covered, fixture.data.length, 'the common gene read every value, once');
  for (const column of [1, 13, 50]) {
    assert.deepEqual(await index.column(column), denseColumn(fixture, column));
  }
  assert.equal(valueRanges.length, afterCommon, 'later genes read nothing');
});

test('a gene spread over every slab, asked for during the pass, reads each slab\'s values once, and later genes read nothing', async () => {
  // Every row holds every fifth gene: each gene spreads over the whole matrix,
  // as the genes of a real atlas do.
  const nRows = 20_000;
  const nCols = 40;
  const indptr = [0];
  const indices = [];
  const data = [];
  for (let row = 0; row < nRows; row++) {
    for (let gene = row % 5; gene < nCols; gene += 5) {
      indices.push(gene);
      data.push(1 + ((row + gene) % 9));
    }
    indptr.push(indices.length);
  }
  const fixture = { nRows, nCols, indptr: Float64Array.from(indptr), indices: Int32Array.from(indices), data: Float32Array.from(data) };
  const valueRanges = [];
  const { index } = sparseIndex(fixture, createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }), {
    valuesOnDemand: true,
    retainIndicesBytes: 1 << 30,
    slabEntries: 4096,
    readValues: async (start, end) => {
      valueRanges.push([start, end]);
      return fixture.data.slice(start, end);
    },
  });
  // Asked for before the pass starts: extracted from every slab.
  assert.deepEqual(await index.column(2), denseColumn(fixture, 2));
  await index.start();
  const read = valueRanges.reduce((sum, [start, end]) => sum + end - start, 0);
  assert.equal(read, fixture.data.length, 'every value read once');
  const afterFirst = valueRanges.length;
  for (const column of [0, 17, 39]) {
    assert.deepEqual(await index.column(column), denseColumn(fixture, column));
  }
  assert.equal(valueRanges.length, afterFirst, 'later genes read nothing');
});

test('genes asked for together are weighed together: one reads its ranges, many at once read every value once', async () => {
  // Gene g lives in its own band of rows, so each gene alone is one short range.
  const nRows = 30_000;
  const nCols = 50;
  const indptr = [0];
  const indices = [];
  const data = [];
  for (let row = 0; row < nRows; row++) {
    const gene = Math.floor(row / (nRows / nCols));
    for (let k = 0; k < 5; k++) {
      indices.push(k === 0 ? gene : (gene + 7 * k) % nCols);
      data.push(1 + ((row + k) % 7));
    }
    indptr.push(indices.length);
  }
  const fixture = { nRows, nCols, indptr: Float64Array.from(indptr), indices: Int32Array.from(indices), data: Float32Array.from(data) };
  const valueRanges = [];
  const { index } = sparseIndex(fixture, createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }), {
    valuesOnDemand: true,
    retainIndicesBytes: 1 << 30,
    slabEntries: 4096,
    // Stored at one byte per value: every value costs about one request more than a gene's range.
    valuesStoredBytes: async () => fixture.data.length,
    readValues: async (start, end) => {
      valueRanges.push([start, end]);
      return fixture.data.slice(start, end);
    },
  });
  await index.start();
  assert.deepEqual(await index.column(3), denseColumn(fixture, 3));
  const alone = valueRanges.reduce((sum, [start, end]) => sum + end - start, 0);
  assert.ok(alone < fixture.data.length / 2, `one gene read ${alone} of ${fixture.data.length} values`);

  valueRanges.length = 0;
  const genes = Array.from({ length: 40 }, (_, i) => i + 10);
  const columns = await Promise.all(genes.map(gene => index.column(gene)));
  columns.forEach((column, i) => assert.deepEqual(column, denseColumn(fixture, genes[i])));
  const covered = valueRanges.reduce((sum, [start, end]) => sum + end - start, 0);
  assert.equal(covered, fixture.data.length, 'forty genes at once read every value, once');
  const afterBatch = valueRanges.length;
  assert.deepEqual(await index.column(0), denseColumn(fixture, 0));
  assert.equal(valueRanges.length, afterBatch, 'later genes read nothing');
});

test('an abandoned spill directory is swept when the app starts; a held one is kept', async () => {
  const { sweepAbandonedIndexes } = await import('../assets/js/data/column-store-placement.js');
  const removed = [];
  const held = new Set(['cellucid-column-index/live']);
  const parent = {
    async *entries() {
      yield ['live', {}];
      yield ['crashed', {}];
    },
    async removeEntry(name) {
      removed.push(name);
    },
  };
  const environment = {
    navigator: {
      storage: { getDirectory: async () => ({ getDirectoryHandle: async () => parent }) },
      locks: { request: async (name, _options, callback) => callback(held.has(name) ? null : { name }) },
    },
  };
  await sweepAbandonedIndexes(environment);
  assert.deepEqual(removed, ['crashed']);
  // No OPFS, or no index directory yet: nothing to do, and nothing thrown.
  await sweepAbandonedIndexes({ navigator: {} });
  await sweepAbandonedIndexes({
    navigator: { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => { throw new DOMException('none', 'NotFoundError'); } }) } },
  });
});

test('a build that failed on a read is made again for the next gene, never answered by the old failure', async () => {
  const fixture = csrFixture(200, 12);
  let failing = true;
  let attempts = 0;
  const { index } = sparseIndex(fixture, createColumnStoreFactory({ memoryBudgetBytes: 1 << 20 }), {
    readIndices: (start, end) => {
      attempts++;
      if (failing) throw new TypeError('the connection dropped while reading');
      return fixture.indices.slice(start, end);
    },
  });
  await assert.rejects(index.column(3), /connection dropped/);
  failing = false;
  const before = attempts;
  assert.deepEqual(await index.column(3), denseColumn(fixture, 3));
  assert.ok(attempts > before, 'the next gene read the matrix again');
  assert.deepEqual(await index.column(5), denseColumn(fixture, 5));
});

test('a slab is read with its values beside its indices only at the end of the pass, where the values asked for after it would cost a round trip of their own', () => {
  const fixture = csrFixture(400, 8);
  const nnz = fixture.indices.length;
  const { index } = sparseIndex(fixture, createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }), {
    valuesOnDemand: true,
    // A round trip moves 64 entries' worth of stored values.
    link: () => ({ measured: true, mergeGapBytes: 16, roundTripBytes: 64 * 4, shapingConcurrency: 6 }),
  });
  // A gene waits; the stored size of a value is known (float32).
  index._active = () => ({});
  index._perEntryBytes = 4;
  const slab = (entryStart, entryEnd) => ({ entryStart, entryEnd });
  assert.equal(index._valuesBeside(slab(0, 16)), false, 'the indices after it hide the round trip its values take');
  assert.equal(index._valuesBeside(slab(nnz - 16, nnz)), true, 'the last slab: its values would cost the pass one more round trip');
  assert.equal(index._valuesBeside(slab(nnz - 100, nnz - 84)), false, 'more than a round trip of indices still to read after it');
  assert.equal(index._valuesBeside(slab(nnz - 70, nnz - 54)), true);
});

test('a structure kept without its values is kept again with them once later genes read them whole: rows and values in column order, exact', async () => {
  const fixture = csrFixture(3000, 40, 11);
  const kept = [];
  let valueReads = 0;
  const { index } = sparseIndex(fixture, createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }), {
    valuesOnDemand: true,
    retainIndicesBytes: 1 << 30,
    slabEntries: 256,
    // Values arrive as a link's do: later.
    readValues: async (start, end) => {
      valueReads++;
      return fixture.data.slice(start, end);
    },
    onBuilt: store => kept.push(store.keptParts()),
  });
  // Built ahead of any gene: the structure alone, no value read.
  await index.start();
  assert.equal(valueReads, 0);
  assert.deepEqual(kept.map(parts => parts.layout), ['structure'], 'kept as entry positions while no value is held');
  // Every gene at once: every value is read whole, once.
  const columns = await Promise.all(Array.from({ length: fixture.nCols }, (_, column) => index.column(column)));
  columns.forEach((values, column) => assert.deepEqual(Array.from(values), Array.from(denseColumn(fixture, column))));
  assert.deepEqual(kept.map(parts => parts.layout), ['structure', 'sparse'], 'kept again, with the values');
  const parts = kept[1];
  const joined = name => {
    const array = parts.arrays.find(item => item.name === name);
    const bytes = Buffer.concat([...array.pieces()].map(piece => Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength)));
    return name === 'rows' ? new Uint32Array(bytes.buffer, bytes.byteOffset, array.length) : new Float32Array(bytes.buffer, bytes.byteOffset, array.length);
  };
  const rows = joined('rows');
  const values = joined('values');
  assert.equal(rows.length, fixture.indices.length);
  for (let column = 0; column < fixture.nCols; column++) {
    const out = new Float32Array(fixture.nRows);
    for (let entry = parts.columnStart[column]; entry < parts.columnStart[column + 1]; entry++) {
      if (entry > parts.columnStart[column]) assert.ok(rows[entry] >= rows[entry - 1], 'rows ascend within a gene');
      out[rows[entry]] = Math.fround(out[rows[entry]] + values[entry]);
    }
    assert.deepEqual(Array.from(out), Array.from(denseColumn(fixture, column)), `gene ${column} from the kept rows and values`);
  }
});

// ---------------------------------------------------------------------------
// Gene indexes kept in this browser: read whole into memory when it holds
// them, else in runs of the genes asked for together; never a read per gene.
// ---------------------------------------------------------------------------

const KEPT_TYPED = { f64: Float64Array, u32: Uint32Array, f32: Float32Array };

/**
 * A built store's `keptParts()` as the reader finds it kept
 * (`kept-column-index.js` `KeptStore`): each per-gene array one stored run
 * of bytes, read through `read(offset, length)` (counted, by array), each
 * gene's piece with its CRC-32.
 */
function keptCopyOf(parts, { rowPointers = null, delayMs = 0 } = {}) {
  const reads = {};
  const stored = {};
  const arrays = {};
  const checks = {};
  const elementStart = parts.layout === 'dense' ? column => column * parts.nRows : column => parts.columnStart[column];
  for (const array of parts.arrays) {
    if (array.name === 'columnStart') continue;
    const bytes = Buffer.concat([...array.pieces()].map(piece => Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength)));
    stored[array.name] = new Uint8Array(bytes);
    reads[array.name] = 0;
    const per = KEPT_TYPED[array.type].BYTES_PER_ELEMENT;
    checks[array.name] = Uint32Array.from({ length: parts.nCols }, (_, column) =>
      checksumOf(stored[array.name].subarray(elementStart(column) * per, elementStart(column + 1) * per)));
    arrays[array.name] = {
      type: array.type,
      read: async (offset, length) => {
        reads[array.name]++;
        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
        return stored[array.name].slice(offset, offset + length);
      },
    };
  }
  const events = { released: 0, discarded: 0 };
  return {
    kept: {
      layout: parts.layout,
      nRows: parts.nRows,
      nCols: parts.nCols,
      nnz: parts.nnz,
      columnStart: parts.columnStart,
      rowPointers,
      arrays,
      checks,
      label: 'X',
      release: () => { events.released++; },
      discard: () => { events.discarded++; },
    },
    reads,
    stored,
    events,
  };
}

/** A built index's kept parts, from a pass over `fixture` (sparse rows and values, or the structure over a slow link). */
async function keptPartsOf(fixture, { structure = false } = {}) {
  let parts = null;
  const { index } = sparseIndex(fixture, createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }), {
    ...(structure ? { valuesOnDemand: true, retainIndicesBytes: 1 << 30, slabEntries: 256 } : {}),
    onBuilt: store => { parts ??= store.keptParts(); },
  });
  await index.start();
  index.dispose();
  return parts;
}

/** Every gene, `batch` at a time (as an analysis asks for them), each batch at once; the genes' dense columns. */
async function readInBatches(index, nCols, batch) {
  const columns = [];
  for (let first = 0; first < nCols; first += batch) {
    const genes = Array.from({ length: Math.min(batch, nCols - first) }, (_, i) => first + i);
    columns.push(...await Promise.all(genes.map(gene => index.sparseColumn(gene))));
  }
  return columns.map(column => {
    const dense = new Float32Array(column.length);
    column.indices.forEach((row, i) => { dense[row] = column.values[i]; });
    return dense;
  });
}

for (const layout of ['sparse', 'structure']) {
  test(`a kept ${layout} index the memory for gene indexes holds is read whole, once, at its first gene; every gene after from memory, exact, counted`, async () => {
    const fixture = csrFixture(3000, 64, 13);
    const parts = await keptPartsOf(fixture, { structure: layout === 'structure' });
    assert.equal(parts.layout, layout);
    const copy = keptCopyOf(parts, { rowPointers: fixture.indptr });
    let valueReads = 0;
    const { index } = sparseIndex(fixture, createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }), {
      kept: copy.kept,
      ...(layout === 'structure' ? { valuesOnDemand: true, retainIndicesBytes: 1 << 30 } : {}),
      readValues: async (start, end) => {
        valueReads++;
        return fixture.data.slice(start, end);
      },
    });
    assert.equal(index.kept, true);
    const before = index.storeBytes;
    const columns = await readInBatches(index, fixture.nCols, 8);
    columns.forEach((values, column) => assert.deepEqual(Array.from(values), Array.from(denseColumn(fixture, column)), `gene ${column}`));
    // The first batch's pieces in one run, beside the whole copy read once:
    // never a read per gene (64 genes, 8 batches).
    for (const [name, count] of Object.entries(copy.reads)) {
      if (name === 'rowPointers' || name === 'fileRows') continue;
      assert.ok(count <= 2, `${name}: ${count} reads of the kept copy for ${fixture.nCols} genes`);
    }
    // Held: the entry positions (a structure: its values are bought from the file as the built one buys them), or the rows and values.
    const held = layout === 'structure' ? parts.nnz * 4 : parts.nnz * 8;
    assert.equal(index._store._reads.heldBytes, held);
    assert.ok(index.storeBytes - before >= held, 'what it holds is counted in the gene index share');
    // Every gene again: nothing more is read of the kept copy.
    const reads = { ...copy.reads };
    await readInBatches(index, fixture.nCols, 8);
    assert.deepEqual(copy.reads, reads, 'held: no read of the kept copy');
    if (layout === 'structure') assert.ok(valueReads > 0, 'values read from the file, as the built structure reads them');
    index.dispose();
  });

  test(`a kept ${layout} index larger than the memory for gene indexes is read in runs of the genes asked together, never a read per gene; exact`, async () => {
    const fixture = csrFixture(3000, 64, 17);
    const parts = await keptPartsOf(fixture, { structure: layout === 'structure' });
    const copy = keptCopyOf(parts, { rowPointers: fixture.indptr });
    const { index } = sparseIndex(fixture, createColumnStoreFactory({ memoryBudgetBytes: 0 }), {
      kept: copy.kept,
      ...(layout === 'structure' ? { valuesOnDemand: true, retainIndicesBytes: 1 << 30 } : {}),
      readValues: async (start, end) => fixture.data.slice(start, end),
    });
    const before = index.storeBytes;
    const columns = await readInBatches(index, fixture.nCols, 8);
    columns.forEach((values, column) => assert.deepEqual(Array.from(values), Array.from(denseColumn(fixture, column)), `gene ${column}`));
    const name = layout === 'structure' ? 'positions' : 'rows';
    assert.equal(copy.reads[name], fixture.nCols / 8, `one read per batch of 8 genes (${copy.reads[name]} for ${fixture.nCols} genes)`);
    assert.equal(index._store._reads.heldBytes, 0, 'nothing of the kept copy held');
    if (layout === 'sparse') assert.equal(index.storeBytes, before);
    index.dispose();
  });
}

test('a kept dense index is read whole when memory holds it; a gene handed out never shares the held copy', async () => {
  const nRows = 50;
  const nCols = 6;
  const values = Float32Array.from({ length: nRows * nCols }, (_, i) => (i % 7) / 2);
  let parts = null;
  const dense = new RowMajorColumnIndex({
    layout: 'dense', nRows, nCols,
    readRows: (rowStart, rowEnd) => values.slice(rowStart * nCols, rowEnd * nCols),
    storeFactory: createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }),
    slabEntries: 20,
    label: 'X',
    onBuilt: store => { parts = store.keptParts(); },
  });
  await dense.start();
  dense.dispose();
  const copy = keptCopyOf(parts);
  const index = new RowMajorColumnIndex({
    layout: 'dense', nRows, nCols,
    readRows: () => assert.fail('a kept index reads no row of the file'),
    storeFactory: createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }),
    label: 'X',
    kept: copy.kept,
  });
  const expected = column => Float32Array.from({ length: nRows }, (_, row) => values[row * nCols + column]);
  for (let round = 0; round < 2; round++) {
    const columns = await Promise.all(Array.from({ length: nCols }, (_, column) => index.column(column)));
    columns.forEach((column, at) => {
      assert.deepEqual(Array.from(column), Array.from(expected(at)));
      assert.equal(column.byteLength, column.buffer.byteLength, 'a column owns its buffer (it may be transferred)');
    });
  }
  assert.ok(copy.reads.values <= 2, `${copy.reads.values} reads of the kept values`);
  assert.equal(index.storeBytes, nRows * nCols * 4);
  index.dispose();
});

test('a damaged gene of a kept copy held in memory is found when it is served: the copy is removed and the index built again, exact', async () => {
  const fixture = csrFixture(2000, 32, 19);
  const parts = await keptPartsOf(fixture);
  const copy = keptCopyOf(parts, { rowPointers: fixture.indptr });
  // One byte of gene 9's values changed on disk.
  copy.stored.values[(parts.columnStart[9] + 1) * 4] ^= 0x40;
  const { index, reads } = sparseIndex(fixture, createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }), { kept: copy.kept });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const columns = await readInBatches(index, fixture.nCols, 4);
    columns.forEach((values, column) => assert.deepEqual(Array.from(values), Array.from(denseColumn(fixture, column)), `gene ${column}`));
  } finally {
    console.warn = warn;
  }
  assert.equal(copy.events.discarded, 1, 'the damaged copy is removed');
  assert.ok(reads.indices > 0, 'the index is built again from the file');
  assert.equal(index.kept, false);
  index.dispose();
});

test('a kept copy priced slower to read than building the index again is let go at its first gene and the index built (not kept again); priced faster, it is read', async () => {
  // A copy of 16 MiB read in 200 ms: what reading kept copies costs here.
  const nRows = 1 << 20;
  const nCols = 4;
  const big = new Float32Array(nRows * nCols);
  for (let i = 0; i < big.length; i += 4099) big[i] = i % 13;
  const bigParts = {
    layout: 'dense', nRows, nCols, nnz: nRows * nCols, columnStart: null,
    arrays: [{ name: 'values', type: 'f32', length: big.length, pieces: () => [new Uint8Array(big.buffer)] }],
  };
  const measured = keptCopyOf(bigParts, { delayMs: 200 });
  const first = new RowMajorColumnIndex({
    layout: 'dense', nRows, nCols,
    readRows: () => assert.fail('read from the kept copy'),
    storeFactory: createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }),
    label: 'X',
    kept: measured.kept,
  });
  // Its first gene, then the whole copy held.
  await first.column(0);
  await until(() => first.storeBytes >= big.byteLength, 'the whole copy held');
  // Kept column-major: gene 3 is the fourth run of rows.
  assert.equal(Buffer.compare(Buffer.from((await first.column(3)).buffer), Buffer.from(big.buffer, 3 * nRows * 4, nRows * 4)), 0);
  first.dispose();

  const small = (rebuildMs, onBuilt) => {
    const rows = 40;
    const values = Float32Array.from({ length: rows * nCols }, (_, i) => i % 5);
    const parts = {
      layout: 'dense', nRows: rows, nCols, nnz: rows * nCols, columnStart: null,
      arrays: [{ name: 'values', type: 'f32', length: values.length, pieces: () => {
        const columnMajor = new Float32Array(values.length);
        for (let r = 0; r < rows; r++) for (let c = 0; c < nCols; c++) columnMajor[c * rows + r] = values[r * nCols + c];
        return [new Uint8Array(columnMajor.buffer)];
      } }],
    };
    const copy = keptCopyOf(parts);
    let rowReads = 0;
    const index = new RowMajorColumnIndex({
      layout: 'dense', nRows: rows, nCols,
      readRows: (rowStart, rowEnd) => {
        rowReads++;
        return values.slice(rowStart * nCols, rowEnd * nCols);
      },
      storeFactory: createColumnStoreFactory({ memoryBudgetBytes: 1 << 30 }),
      label: 'X',
      kept: copy.kept,
      rebuildMs: () => rebuildMs,
      onBuilt,
    });
    const expected = column => Array.from({ length: rows }, (_, row) => values[row * nCols + column]);
    return { index, copy, expected, rowReads: () => rowReads };
  };
  // Building priced at a microsecond: reading the copy costs more.
  let built = 0;
  const slow = small(0.001, () => { built++; });
  assert.deepEqual(Array.from(await slow.index.column(2)), slow.expected(2));
  assert.ok(slow.rowReads() > 0, 'built from the file');
  assert.equal(slow.index.kept, false);
  assert.deepEqual(slow.copy.reads, { values: 0 }, 'nothing read of the copy');
  assert.deepEqual(slow.copy.events, { released: 1, discarded: 0 }, 'let go, never removed');
  assert.equal(built, 0, 'not kept again');
  slow.index.dispose();
  // Building priced at a minute: the copy is read.
  const fast = small(60_000, () => assert.fail('nothing is built'));
  assert.deepEqual(Array.from(await fast.index.column(2)), fast.expected(2));
  assert.equal(fast.rowReads(), 0);
  assert.equal(fast.index.kept, true);
  fast.index.dispose();
});
