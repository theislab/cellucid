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

test('the column-index memory budget follows the device memory the browser reports', () => {
  const GiB = 1024 ** 3;
  assert.equal(columnIndexMemoryBudget({ navigator: { deviceMemory: 8 } }), 2 * GiB);
  assert.equal(
    columnIndexMemoryBudget({ navigator: {}, performance: { memory: { jsHeapSizeLimit: 4 * GiB } } }),
    2 * GiB
  );
  assert.equal(columnIndexMemoryBudget({}), GiB);
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
