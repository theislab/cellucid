import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RowMajorColumnIndex,
  createColumnStoreFactory,
} from '../assets/js/data/sparse-column-index.js';
import { columnIndexMemoryBudget } from '../assets/js/data/column-store-placement.js';

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

test('with no memory and no disk, genes are answered by scanning, never refused', async () => {
  const fixture = csrFixture(150, 7);
  const factory = {
    sparse: async () => null,
    dense: async () => null,
  };
  const { index } = sparseIndex(fixture, factory);
  await index.start();
  assert.equal(index.phase, 'unindexed');
  const [a, b] = await Promise.all([index.column(1), index.column(5)]);
  assert.deepEqual(a, denseColumn(fixture, 1));
  assert.deepEqual(b, denseColumn(fixture, 5));
  assert.deepEqual(await index.column(1), denseColumn(fixture, 1));
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
